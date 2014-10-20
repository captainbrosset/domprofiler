"use strict";

const {classes: Cc, interfaces: Ci, utils: Cu, results: Cr} = Components;
const els = Cc["@mozilla.org/eventlistenerservice;1"]
            .getService(Ci.nsIEventListenerService);
const {devtools} = Cu.import("resource://gre/modules/devtools/Loader.jsm", {});
const {on, off, emit} = devtools.require("sdk/event/core");

/**
 * The page change recorder util itself. Doesn't care about UI, just starts and
 * stops a recording an returns a list of changes.
 */
function PageChangeRecorder(doc) {
  this.doc = doc;
  this.win = this.doc.defaultView;
  this.isStarted = false;

  this._onMutations = this._onMutations.bind(this);
  this._onEvent = this._onEvent.bind(this);

  // Get the mutation observer ready
  this._mutationObserver = new this.win.MutationObserver(this._onMutations);

  this.changes = [];
}

PageChangeRecorder.prototype = {
  MUTATION_SCREENSHOT_DEBOUNCE: 100,
  REGULAR_SCREENSHOT_INTERVAL: 200,

  destroy() {
    this.doc = this.win = this.changes = this._mutationObserver = null;
  },

  start() {
    if (this.isStarted) {
      return;
    }
    this.isStarted = true;
    this.changes = [];

    // Start observing markup mutations
    this._mutationObserver.observe(this.doc, {
      attributes: true,
      attributeOldValue: true,
      childList: true,
      subtree: true
    });

    // Start observing DOM events that have listeners
    this.addedListeners = this._getListeners();
    for (let [node, listeners] of this.addedListeners) {
      // Add one system-group event listener per default event type found
      // so we can be called whenever one happens even if the handler prevents
      // propagation.
      for (let {type} of listeners) {
        els.addSystemEventListener(node, type, this._onEvent, true);
      }
    }
  },
  
  stop() {
    if (!this.isStarted) {
      return;
    }

    this.isStarted = false;

    for (let [node, listeners] of this.addedListeners) {
      for (let {type} of listeners) {
        els.removeSystemEventListener(node, type, this._onEvent, true);
      }
    }
    this.addedListenerTypes = null;
    this._mutationObserver.disconnect();

    return this.changes;
  },
  
  _getListeners() {
    // Get the list of all event types that have listeners in content
    let nodes = this.doc.getElementsByTagName("*");
    let nodeEventListeners = new Map();
    for (let node of nodes) {
      let listeners = els.getListenerInfoFor(node);
      for (let listener of listeners) {
        if (!nodeEventListeners.has(node)) {
          nodeEventListeners.set(node, []);
        }
        nodeEventListeners.get(node).push(listener);
      }
    }
    return nodeEventListeners;
  },

  _onMutations(mutations) {
    if (!this.isStarted) {
      return;
    }

    for (let mutation of mutations) {
      // Build a reason object that will let the user know what exactly happened
      let reason = mutation;
      if (mutation.type === "attributes") {
        reason = {
          name: mutation.attributeName,
          oldValue: mutation.oldValue,
          value: mutation.target.getAttribute(mutation.attributeName)
        };
      } else if (mutation.type === "childList") {
        reason = {
          addedNodes: mutation.addedNodes.length,
          removedNodes: mutation.removedNodes.length
        };
      }
      // XXX: add more mutation reason types

      this._addChange("mutation", {
        target: mutation.target,
        type: mutation.type,
        reason
      });
    }
  },

  _onEvent({type, target}) {
    this._addChange("event", {type, target});
  },

  _getScreenshot() {
    if (!this.isStarted) {
      return;
    }

    // Don't take two consecutive screenshots
    if (this.changes.length &&
        this.changes[this.changes.length - 1].type === "screenshot") {
      return;
    }

    if (!this._screenshotCtx) {
      let canvas = this.doc.createElement("canvas");
      this._screenshotCtx = canvas.getContext("2d");
    }

    let left = this.win.scrollX;
    let top = this.win.scrollY;
    let width = this.win.innerWidth;
    let height = this.win.innerHeight;

    let winUtils = this.win.QueryInterface(Ci.nsIInterfaceRequestor)
                           .getInterface(Ci.nsIDOMWindowUtils);
    let scrollbarHeight = {};
    let scrollbarWidth = {};
    winUtils.getScrollbarSize(false, scrollbarWidth, scrollbarHeight);
    width -= scrollbarWidth.value;
    height -= scrollbarHeight.value;

    this._screenshotCtx.canvas.width = width;
    this._screenshotCtx.canvas.height = height;
    this._screenshotCtx.drawWindow(this.win, left, top, width, height, "#fff");

    return this._screenshotCtx.canvas.toDataURL("image/png", "");
  },

  _takeScreenshot() {
    this._addChange("screenshot", this._getScreenshot());
  },

  _addChange(type, data) {
    let time = this.win.performance.now();
    this.changes.push({type, data, time});
    // XXX Try to take a screenshot at each change
    this.changes.push({type: "screenshot", data: this._getScreenshot(), time});

    // XXX Keeping the 'changes' array for now even though we stream records
    // every time we get one.
    emit(this, "records", this.changes);
    this.changes = [];
  },
};

let currentRecorder;

function onRecorderUpdate(records) {
  if (!currentRecorder) {
    return;
  }

  // We need to send DOM nodes separately so they become CPOWs, so create a
  // second records array that has the same size but only contains DOM nodes at
  // the expected indexes.
  let nodes = [];
  for (let {type, data} of records) {
    if (data.target) {
      nodes.push(data.target);
      delete data.target;
    } else {
      nodes.push(null);
    }
  }

  sendAsyncMessage("PageRecorder:OnUpdate", records, nodes);
}

addMessageListener("PageRecorder:Start", function() {
  if (currentRecorder) {
    throw new Error("A recording is already in progress");
  }
  currentRecorder = new PageChangeRecorder(content.document);
  on(currentRecorder, "records", onRecorderUpdate);
  currentRecorder.start();
});

addMessageListener("PageRecorder:Stop", function() {
  let records = currentRecorder.stop();
  off(currentRecorder, "records", onRecorderUpdate);
  currentRecorder.destroy();
  currentRecorder = null;
});

// Using our own, crappy, highlighter.
// We could require the boxmodel highlighter module here and use it but this
// won't work in e10s, so let's wait for bug 985597 to be done first.
let currentHighlightedNode;
addMessageListener("PageRecorder:HighlightNode", function({objects}) {
  // XXX the outline-based highlighter triggers mutations if used during the
  // recording. So just don't.
  if (currentRecorder) {
    return;
  }

  if (currentHighlightedNode) {
    currentHighlightedNode.style.outline = "";
  }
  objects.node.style.outline = "2px dashed #f06";
  currentHighlightedNode = objects.node;
});

addMessageListener("PageRecorder:UnhighlightNode", function() {
  // XXX the outline-based highlighter triggers mutations if used during the
  // recording. So just don't.
  if (currentRecorder) {
    return;
  }

  if (currentHighlightedNode) {
    currentHighlightedNode.style.outline = "";
  }
});

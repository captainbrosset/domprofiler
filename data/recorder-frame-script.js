"use strict";

const {classes: Cc, interfaces: Ci, utils: Cu, results: Cr} = Components;
const els = Cc["@mozilla.org/eventlistenerservice;1"]
            .getService(Ci.nsIEventListenerService);
const {devtools} = Cu.import("resource://gre/modules/devtools/Loader.jsm", {});
const {on, off, emit} = devtools.require("sdk/event/core");

/**
 * The page change recorder util itself. Doesn't care about UI, just starts and
 * stops a recording an emits records as it goes.
 */
function PageChangeRecorder(doc) {
  this.doc = doc;
  this.win = this.doc.defaultView;
  this.isStarted = false;

  this.changeID = 0;

  this._onMutations = this._onMutations.bind(this);
  this._onEvent = this._onEvent.bind(this);

  // Get the mutation observer ready
  this._mutationObserver = new this.win.MutationObserver(this._onMutations);

  this.screenshots = new Map();
}

PageChangeRecorder.prototype = {
  MUTATION_SCREENSHOT_DEBOUNCE: 100,
  REGULAR_SCREENSHOT_INTERVAL: 200,

  destroy() {
    this.screenshots.clear();
    this.doc = this.win = this._mutationObserver = null;
  },

  start() {
    if (this.isStarted) {
      return;
    }
    this.isStarted = true;
    this.screenshots.clear();

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

      this._emitChange("mutation", {
        target: mutation.target,
        type: mutation.type,
        reason
      });
    }
  },

  _onEvent({type, target}) {
    this._emitChange("event", {type, target});
  },

  _getScreenshot() {
    if (!this.isStarted) {
      return;
    }

    if (!this._screenshotCtx) {
      let canvas = this.doc.createElement("canvas");
      this._screenshotCtx = canvas.getContext("2d");
      this._screenshotCtx.canvas.width = this.win.innerWidth;
      this._screenshotCtx.canvas.height = this.win.innerHeight;
    }

    this._screenshotCtx.drawWindow(this.win,
                                   this.win.scrollX,
                                   this.win.scrollY,
                                   this._screenshotCtx.canvas.width,
                                   this._screenshotCtx.canvas.height,
                                   "#fff");

    return this._screenshotCtx.canvas.toDataURL("image/png", "");
  },

  _emitChange(type, data) {
    let time = this.win.performance.now();
    let screenshot = this._getScreenshot();
    let id = this.changeID++;

    this.screenshots.set(id, screenshot);

    // Emit this one change over the wire, along with a unique ID so the UI
    // can request the screenshot for this change when needed.
    emit(this, "change", {type, data, time, id});
  },
};

let currentRecorder;

function isRecording() {
  return currentRecorder && currentRecorder.isStarted;
}

function onChange({type, data, time, id}) {
  if (!isRecording()) {
    return;
  }

  // We need to send DOM nodes separately so they become CPOWs
  let object = data.target;
  delete data.target;
  sendAsyncMessage("PageRecorder:OnChange", {type, data, time, id}, object);
}

addMessageListener("PageRecorder:Start", function() {
  if (isRecording()) {
    throw new Error("A recording is already in progress");
  }

  if (currentRecorder) {
    currentRecorder.destroy();
    currentRecorder = null;
  }

  currentRecorder = new PageChangeRecorder(content.document);
  on(currentRecorder, "change", onChange);
  currentRecorder.start();
});

addMessageListener("PageRecorder:Stop", function() {
  let records = currentRecorder.stop();
  off(currentRecorder, "change", onChange);
});

addMessageListener("PageRecorder:GetScreenshot", function({data: id}) {
  if (!currentRecorder) {
    throw new Error("No recorder available");
  }

  let screenshot = currentRecorder.screenshots.get(id);
  if (screenshot) {
    sendAsyncMessage("PageRecorder:OnScreenshot", screenshot);
  }
});

// Using our own, crappy, highlighter.
// We could require the boxmodel highlighter module here and use it but this
// won't work in e10s, so let's wait for bug 985597 to be done first.
let currentHighlightedNode;
addMessageListener("PageRecorder:HighlightNode", function({objects}) {
  // XXX the outline-based highlighter triggers mutations if used during the
  // recording. So just don't.
  if (isRecording()) {
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
  if (isRecording()) {
    return;
  }

  if (currentHighlightedNode) {
    currentHighlightedNode.style.outline = "";
  }
});

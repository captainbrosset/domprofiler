"use strict";

const {classes: Cc, interfaces: Ci, utils: Cu, results: Cr} = Components;
const els = Cc["@mozilla.org/eventlistenerservice;1"]
          .getService(Ci.nsIEventListenerService);
const {devtools} = Cu.import("resource://gre/modules/devtools/Loader.jsm", {});
const {HIGHLIGHTER_CLASSES} = devtools.require("devtools/server/actors/highlighter");
const {BoxModelHighlighter} = HIGHLIGHTER_CLASSES;

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
  this._onAfterPaint = this._onAfterPaint.bind(this);

  // Get the mutation observer ready
  this._mutationObserver = new this.win.MutationObserver(this._onMutations);

  this.changes = [];
}

PageChangeRecorder.prototype = {
  SCREENSHOT_DEBOUNCE_TIMEOUT: 100,

  destroy() {
    this.doc = this.win = this.changes = this._mutationObserver = null;
  },

  start() {
    if (this.isStarted) {
      return;
    }
    this.isStarted = true;
    
    this.changes = [];
    
    // Take a screenshot at the start
    this._takeScreenshot();

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
      // so we can be called whenever one happens even if the handler prevents propagation.
      for (let {type} of listeners) {
        els.addSystemEventListener(node, type, this._onEvent, true);
      }
    }
    
    // Observe afterpaint events to capture screenshots of the page when it changes
    content.addEventListener("MozAfterPaint", this._onAfterPaint);
  },
  
  stop() {
    if (!this.isStarted) {
      return;
    }
    
    // Take a screenshot at the end
    this._takeScreenshot();
    
    this.isStarted = false;

    for (let [node, listeners] of this.addedListeners) {
      for (let {type} of listeners) {
        els.removeSystemEventListener(node, type, this._onEvent, true);
      }
    }
    this.addedListenerTypes = null;
    this._mutationObserver.disconnect();
    
    content.removeEventListener("MozAfterPaint", this._onAfterPaint);
    
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
  
  _onAfterPaint(e) {
    if (!e.clientRects.length) {
      return;
    }

    if (this._paintDebounce) {
      clearTimeout(this._paintDebounce);
    }
    this._paintDebounce = setTimeout(() => {
      this._takeScreenshot();
    }, this.SCREENSHOT_DEBOUNCE_TIMEOUT);
  },
  
  _takeScreenshot() {
    if (!this.isStarted) {
      return;
    }
    
    // Don't take two consecutive screenshots
    if (this.changes.length && this.changes[this.changes.length - 1].type === "screenshot") {
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
    
    this._addChange("screenshot", this._screenshotCtx.canvas.toDataURL("image/png", ""));
  },
  
  _addChange(type, data) {
    this.changes.push({type, data, time: this.doc.defaultView.performance.now()});
  },
};

let currentRecorder;

addMessageListener("PageRecorder:Start", function() {
  if (currentRecorder) {
    throw new Error("A recording is already in progress");
  }
  currentRecorder = new PageChangeRecorder(content.document);
  currentRecorder.start();
});

addMessageListener("PageRecorder:Stop", function() {
  let records = currentRecorder.stop();
  currentRecorder.destroy();
  currentRecorder = null;

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

  sendAsyncMessage("PageRecorder:Stop", records, nodes);
});


// XXX will only work with the new nsCanvasFrame-based highlighter
// const highlighter = new BoxModelHighlighter({
//   window: content
// });
// addMessageListener("PageRecorder:HighlightNode", function() {});

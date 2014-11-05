"use strict";

const {classes: Cc, interfaces: Ci, utils: Cu, results: Cr} = Components;
const els = Cc["@mozilla.org/eventlistenerservice;1"]
            .getService(Ci.nsIEventListenerService);
const {devtools} = Cu.import("resource://gre/modules/devtools/Loader.jsm", {});
const {on, off, emit} = devtools.require("sdk/event/core");

/**
 * The page change recorder util itself. Doesn't care about UI, just starts and
 * stops a recording and emits records as it goes.
 */
function PageChangeRecorder(doc) {
  this.doc = doc;
  this.win = this.doc.defaultView;
  this.isStarted = false;

  this.id = 0;

  this._onMutations = this._onMutations.bind(this);
  this._onEvent = this._onEvent.bind(this);

  // Get the mutation observer ready
  this._mutationObserver = new this.win.MutationObserver(this._onMutations);
}

PageChangeRecorder.prototype = {
  destroy() {
    this.doc = this.win = this._mutationObserver = null;
  },

  start() {
    if (this.isStarted) {
      return;
    }
    this.isStarted = true;
    this.startTime = this.win.performance.now();

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
      for (let listener of listeners) {
        let {type, listenerObject} = listener.listener;
        let onEvent = e => {
          this._onEvent(e.type, e.target, listenerObject + "");
        };
        els.addSystemEventListener(node, type, onEvent, true);
        listener.cb = onEvent;
      }
    }
  },
  
  stop() {
    if (!this.isStarted) {
      return;
    }

    this.isStarted = false;

    for (let [node, listeners] of this.addedListeners) {
      for (let {cb, listener} of listeners) {
        els.removeSystemEventListener(node, listener.type, cb, true);
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
        nodeEventListeners.get(node).push({
          listener: listener,
          cb: null
        });
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

  _onEvent(type, target, functionDeclaration) {
    this._emitChange("event", {type, target, functionDeclaration});
  },

  _emitChange(type, data) {
    let time = this.win.performance.now();
    time -= this.startTime;
    emit(this, "change", {type, data, time, id: this.id++});
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

addMessageListener("PageRecorder:SetInspectingNode", function({objects}) {
  let inspector = devtools.require("devtools/server/actors/inspector");
  inspector.setInspectingNode(objects.node);
});

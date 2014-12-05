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

  this.records = [];
  this.currentIndex = -1;

  this._onMutations = this._onMutations.bind(this);
  this._onEvent = this._onEvent.bind(this);

  // Get the mutation observer ready
  this._mutationObserver = new this.win.MutationObserver(this._onMutations);
}

PageChangeRecorder.prototype = {
  destroy() {
    this.doc = this.win = this._mutationObserver = this.records = null;
  },

  start() {
    if (this.isStarted) {
      return;
    }
    this.isStarted = true;
    this.startTime = this.win.performance.now();
    this.currentIndex = -1;

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

    this.currentIndex = this.records.length - 1;
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

    let record = {type, data, time, id: this.id++};
    this.records.push(record);
    emit(this, "change", record);
  },

  moveTo(index) {
    if (!this.records.length ||
        !this.records[this.currentIndex] ||
        !this.records[index]) {
      throw new Error("Cannot moved from index " + this.currentIndex + " to index " + index);
      return;
    }

    let isReverse = this.currentIndex > index;
    for (let i = 0; i < Math.abs(index - this.currentIndex); i ++) {
      let recordIndex = isReverse ? this.currentIndex - i : this.currentIndex + i;
      let {type, data} = this.records[recordIndex];

      // Only replay mutations
      if (type !== "mutation") {
        continue;
      }

      if (data.type === "attributes") {
        data.target.setAttribute(data.reason.name,
          isReverse ? data.reason.oldValue : data.reason.value);
      }
    }
  }
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
  let objects = {
    target: data.target
  };
  // delete data.target;
  sendAsyncMessage("PageRecorder:OnChange", {type, data, time, id}, objects);
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

addMessageListener("PageRecorder:Move", function({data}) {
  if (!currentRecorder || isRecording()) {
    throw new Error("Cannot move to a record index while recording");
    return;
  }

  currentRecorder.moveTo(data.index);
});

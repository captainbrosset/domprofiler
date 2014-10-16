"use strict";

const self = require("sdk/self");
const FRAME_SCRIPT_URL = self.data.url("recorder-frame-script.js");

function PageRecorderPanel(win, toolbox) {
  this.win = win;
  this.doc = this.win.document;
  this.toolbox = toolbox;

  this._onRecordings = this._onRecordings.bind(this);
  this.start = this.start.bind(this);
  this.stop = this.stop.bind(this);

  this.mm = toolbox.target.tab.linkedBrowser.messageManager;
  this.loadFrameScript();

  this.initUI();
}

exports.PageRecorderPanel = PageRecorderPanel;

PageRecorderPanel.prototype = {
  loadFrameScript() {
    this.mm.loadFrameScript(FRAME_SCRIPT_URL, false);
    this.mm.addMessageListener("PageRecorder:Stop", this._onRecordings);

    // Make sure this is only called once on this instance
    this.loadFrameScript = () => {
      console.warn("Frame script " + FRAME_SCRIPT_URL + " has already been loaded");
    };
  },

  initUI() {
    this.outputEl = this.doc.querySelector("#out");
    this.doc.querySelector("#start").addEventListener("click", this.start);
    this.doc.querySelector("#stop").addEventListener("click", this.stop);
  },

  start() {
    this.outputEl.innerHTML = "";
    this.mm.sendAsyncMessage("PageRecorder:Start");
  },

  stop() {
    this.mm.sendAsyncMessage("PageRecorder:Stop");
  },

  _onRecordings({data: records, objects}) {
    // data and objects are 2 equally sized arrays, data contains the actual
    // records, and objects the corresponding CPOW targets if any.
    for (let i = 0; i < records.length; i ++) {
      let record = records[i];
      let target = objects[i];

      let li = this.doc.createElement("li");
      li.classList.add("record");
      li.classList.add(record.type);

      if (this["_buildRecordOutputFor_" + record.type]) {
        this["_buildRecordOutputFor_" + record.type](li, record.data, record.time, target);
      } else {
        this["_buildRecordOutputFor_unknown"](li, record.data, record.time, target);
      }

      this.outputEl.appendChild(li);
    }
  },

  _buildRecordOutputFor_mutation(parentEl, data, time, target) {
    // Break it down further by mutation type
    if (this["_buildRecordOutputFor_mutation_" + data.type]) {
      this["_buildRecordOutputFor_mutation_" + data.type](parentEl, data, time, target);
    } else {
      this["_buildRecordOutputFor_unknown"](parentEl, data, time, target);
    }
  },

  _buildRecordOutputFor_mutation_attributes(parentEl, {reason}, time, target) {
    parentEl.textContent = "Attributes change on node " + target +
                           ". " + reason.name + " changed from " + reason.oldValue +
                           " to " + reason.value;
  },

  _buildRecordOutputFor_event(parentEl, data, time, target) {
    parentEl.textContent = "Event type " + data.type + " on node " + target;
  },

  _buildRecordOutputFor_screenshot(parentEl, data, time, target) {
    let img = this.doc.createElement("img");
    img.src = data;
    img.style.width = "400px";

    parentEl.appendChild(img);
  },

  _buildRecordOutputFor_unknown(parentEl, data, time, target) {
    parentEl.textContent = "Unknown change";
  }
};

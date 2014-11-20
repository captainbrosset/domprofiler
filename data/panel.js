"use strict";

const {Cu} = require("chrome");
const self = require("sdk/self");
const {on, off, emit} = require("sdk/event/core");
const {Task} = Cu.import("resource://gre/modules/Task.jsm", {});

const FRAME_SCRIPT_URL = self.data.url("recorder-frame-script.js");

/**
 * The RecorderController is responsible for toggling the recording in the
 * content process and getting the data.
 * It also manages a list of past recordings and allows to get them as
 * stringified json for exporting.
 */
function RecorderController(toolbox) {
  this.mm = toolbox.target.tab.linkedBrowser.messageManager;
  this.mm.loadFrameScript(FRAME_SCRIPT_URL, false);

  this.onRecord = this.onRecord.bind(this);
  this.mm.addMessageListener("PageRecorder:OnChange", this.onRecord);

  this.sessions = [];
}

RecorderController.prototype = {
  createNewSession() {
    this.sessions.push({
      time: Date.now(),
      records: [],
      duration: null
    });
  },

  get lastSession() {
    return this.sessions[this.sessions.length - 1];
  },

  start() {
    if (this.isStarted) {
      return;
    }
    this.isStarted = true;

    this.createNewSession();
    this.mm.sendAsyncMessage("PageRecorder:Start");

    return this.lastSession;
  },

  stop() {
    if (!this.isStarted) {
      return;
    }
    this.isStarted = false;

    this.mm.sendAsyncMessage("PageRecorder:Stop");
    this.lastSession.duration = Date.now() - this.lastSession.time;

    return this.lastSession;
  },

  onRecord(msg) {
    if (!this.isStarted) {
      return;
    }

    this.lastSession.records.push(msg);
    emit(this, "record", msg);
  }
};

/**
 * The RecorderPanel is responsible for the UI of the tool.
 */
function RecorderPanel(win, toolbox) {
  this.controller = new RecorderController(toolbox);

  this.win = win;
  this.doc = this.win.document;
  this.toolbox = toolbox;

  this.toggle = this.toggle.bind(this);
  this.onRecord = this.onRecord.bind(this);
  this.search = this.search.bind(this);

  this.initUI();
}

exports.RecorderPanel = RecorderPanel;

RecorderPanel.prototype = {
  destroy() {
    this.win = this.doc = this.toolbox = this.mm = null;
  },

  initUI() {
    this.recordsEl = this.doc.querySelector(".records");
    this.toggleEl = this.doc.querySelector("#toggle");
    this.searchBoxEl = this.doc.querySelector("#search-input");

    this.toggleEl.addEventListener("click", this.toggle);
    this.searchBoxEl.addEventListener("input", this.search);
  },

  toggle() {
    if (!this.controller.isStarted) {
      this.toggleEl.setAttribute("checked", "true")
      this.recordsEl.innerHTML = "";
      this.controller.start();
      on(this.controller, "record", this.onRecord);
    } else {
      this.toggleEl.removeAttribute("checked");
      off(this.controller, "record", this.onRecord);
      this.controller.stop();
    }
  },

  matchesSearchQuery(recordEl) {
    let query = this.searchBoxEl.value.toLowerCase();
    if (query === "") {
      return true;
    }

    return recordEl.textContent.toLowerCase().indexOf(query) > -1;
  },

  search() {
    if (!this.recordsEl.children.length) {
      return;
    }

    for (let el of this.recordsEl.querySelectorAll("li")) {
      if (this.matchesSearchQuery(el)) {
        el.style.removeProperty("display");
      } else {
        el.style.display = "none";
      }
    }
  },

  onRecord({data: record, objects}) {
    let el = this.recordsEl;
    let target = objects.target;

    let hasScroll = el.offsetHeight < el.scrollHeight;
    let isScrolledDown = el.scrollTop + el.offsetHeight >= el.scrollHeight;

    let li = this.doc.createElement("li");
    li.classList.add("record");
    li.classList.add(record.type);

    li.appendChild(this.buildTimeOutput(record.time));

    if (target) {
      let targetEl = this.buildTargetOutput(target);
      li.appendChild(targetEl);
      // Adding mouse interaction to the target
      let self = this;
      (function(node) {
        targetEl.addEventListener("mouseover", () => {
          self.highlightNode(node);
        });
        targetEl.addEventListener("mouseout", () => {
          self.unhighlight();
        });
        targetEl.addEventListener("click", () => {
          self.inspectNode(node);
        });
      })(target);
    }

    let formatterData = {
      parentEl: li,
      data: record.data,
      time: record.time
    };
    if (this["buildRecordOutputFor_" + record.type]) {
      this["buildRecordOutputFor_" + record.type](formatterData);
    } else {
      this["buildRecordOutputFor_unknown"](formatterData);
    }

    if (!this.matchesSearchQuery(li)) {
      li.style.display = "none";
    }

    el.appendChild(li);

    // Auto-scroll to bottom if the user hasn't scrolled up
    if (!hasScroll || isScrolledDown) {
      el.scrollTop = el.scrollHeight;
    }
  },

  getNodeFront: Task.async(function*(node) {
    if (!node || Cu.isDeadWrapper(node)) {
      return null;
    }

    // Set, via the frame-script, the provided node as the "inspecting node" on
    // the inspector module. This way we can later retrieve it via the walker
    // actor.
    this.controller.mm.sendAsyncMessage("PageRecorder:SetInspectingNode",
                                        null, {node});

    // Make sure the inspector/waler/highlighter actors are ready
    yield this.toolbox.initInspector();

    // Retrieve the node front from the walker
    return this.toolbox.walker.findInspectingNode();
  }),

  inspectNode: Task.async(function*(node) {
    let nodeFront = yield this.getNodeFront(node);
    if (!nodeFront) {
      return;
    }

    let panel = yield this.toolbox.selectTool("inspector");
    panel.selection.setNodeFront(nodeFront);
  }),

  highlightNode: Task.async(function*(node) {
    let nodeFront = yield this.getNodeFront(node);
    if (!nodeFront) {
      return;
    }

    yield this.toolbox.highlighterUtils.highlightNodeFront(nodeFront);
  }),

  unhighlight: Task.async(function*() {
    yield this.toolbox.highlighterUtils.unhighlight();
  }),

  buildRecordOutputFor_mutation(formatterData) {
    // Break it down further by mutation type
    let type = formatterData.data.type;
    if (this["buildRecordOutputFor_mutation_" + type]) {
      this["buildRecordOutputFor_mutation_" + type](formatterData);
    } else {
      this["buildRecordOutputFor_unknown"](formatterData);
    }
  },

  buildRecordOutputFor_mutation_attributes({parentEl, data, time}) {
    let {name, oldValue, value} = data.reason;

    let outputEl = this.doc.createElement("span");
    outputEl.innerHTML = "Attribute <span class='attribute-name'>" + name +
                         "</span> changed from \"<span class='attribute-value'>" +
                         oldValue + "</span>\" to \"<span class='attribute-value'>" +
                         value + "</span>\"";
    parentEl.appendChild(outputEl);
  },

  buildRecordOutputFor_mutation_childList({parentEl, data, time}) {
    let {addedNodes, removedNodes} = data.reason;

    let outputEl = this.doc.createElement("span");
    outputEl.innerHTML = "Child nodes changed: added " + addedNodes + " nodes" +
                         " and removed " + removedNodes + " nodes";
    parentEl.appendChild(outputEl);
  },

  buildRecordOutputFor_event({parentEl, data, time}) {
    let outputEl = this.doc.createElement("span");
    outputEl.innerHTML = "Event <span class='event-name'>" + data.type +
                         "</span> handled";
    parentEl.appendChild(outputEl);
  },

  buildRecordOutputFor_unknown({parentEl, data, time}) {
    let outputEl = this.doc.createElement("span");
    outputEl.textContent = "Unknown change";
    parentEl.appendChild(outputEl);
  },

  buildTargetOutput(target) {
    let targetEl = this.doc.createElement("span");
    targetEl.classList.add("target");

    let tagEl = this.doc.createElement("span");
    tagEl.classList.add("target-tag");
    tagEl.textContent = "<" + target.localName;
    targetEl.appendChild(tagEl);

    if (target.id) {
      let idEl = this.doc.createElement("span");
      idEl.classList.add("target-id");
      idEl.textContent = "#" + target.id;
      targetEl.appendChild(idEl);
    }
    if (target.classList && target.classList.length) {
      let classesEl = this.doc.createElement("span");
      classesEl.classList.add("target-classes");
      classesEl.textContent = "." + [...target.classList].join(".");
      targetEl.appendChild(classesEl);
    }

    let closeTagEl = this.doc.createElement("span");
    closeTagEl.classList.add("target-tag");
    closeTagEl.textContent = ">";
    targetEl.appendChild(closeTagEl);

    return targetEl;
  },

  buildTimeOutput(time) {
    time = Math.round(time / 1000 * 100) / 100;

    let timeEl = this.doc.createElement("span");
    timeEl.classList.add("time");
    timeEl.textContent = time + " sec";

    return timeEl;
  }
};

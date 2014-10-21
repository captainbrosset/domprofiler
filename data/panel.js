"use strict";

const {Cu} = require("chrome");
const self = require("sdk/self");
const {Task} = Cu.import("resource://gre/modules/Task.jsm", {});

const FRAME_SCRIPT_URL = self.data.url("recorder-frame-script.js");

function PageRecorderPanel(win, toolbox) {
  this.win = win;
  this.doc = this.win.document;
  this.toolbox = toolbox;

  this.onRecord = this.onRecord.bind(this);
  this.onScreenshot = this.onScreenshot.bind(this);
  this.toggle = this.toggle.bind(this);
  this.search = this.search.bind(this);

  this.mm = toolbox.target.tab.linkedBrowser.messageManager;
  this.loadFrameScript();

  this.initUI();
}

exports.PageRecorderPanel = PageRecorderPanel;

PageRecorderPanel.prototype = {
  destroy() {
    this.win = this.doc = this.toolbox = this.mm = null;
  },

  loadFrameScript() {
    this.mm.loadFrameScript(FRAME_SCRIPT_URL, false);
    this.mm.addMessageListener("PageRecorder:OnChange", this.onRecord);
    this.mm.addMessageListener("PageRecorder:OnScreenshot", this.onScreenshot);

    // Make sure this is only called once on this instance
    this.loadFrameScript = () => {
      console.warn("Frame script " + FRAME_SCRIPT_URL + " has already been loaded");
    };
  },

  initUI() {
    this.recordsEl = this.doc.querySelector(".records");
    this.screenshotEl = this.doc.querySelector(".screenshots img");
    this.toggleEl = this.doc.querySelector("#toggle");
    this.searchBoxEl = this.doc.querySelector("#search-input");

    this.toggleEl.addEventListener("click", this.toggle);
    this.searchBoxEl.addEventListener("input", this.search);
  },

  toggle() {
    if (!this.isStarted) {
      this.start();
    } else {
      this.stop();
    }
  },

  start() {
    if (this.isStarted) {
      return;
    }
    this.isStarted = true;

    this.toggleEl.setAttribute("checked", "true")
    this.recordsEl.innerHTML = "";
    this.mm.sendAsyncMessage("PageRecorder:Start");
  },

  stop() {
    if (!this.isStarted) {
      return;
    }
    this.isStarted = false;

    this.toggleEl.removeAttribute("checked");
    this.searchBoxEl.removeAttribute("disabled");
    this.mm.sendAsyncMessage("PageRecorder:Stop");
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

  onRecord({data: record, objects: target}) {
    if (!this.isStarted) {
      return;
    }

    let li = this.doc.createElement("li");
    li.classList.add("record");
    li.classList.add(record.type);

    let self = this;
    (function(id, node) {
      li.addEventListener("mouseover", () => {
        // Highlight the corresponding node
        self.highlightNode(node);

        // And request the screenshot data for this step
        self.mm.sendAsyncMessage("PageRecorder:GetScreenshot", id);
      });
      li.addEventListener("mouseout", () => {
        self.unhighlight();
      });
      li.addEventListener("click", () => {
        self.inspectNode(node);
      });
    })(record.id, target);

    if (target) {
      li.appendChild(this.buildTargetOutput(target));
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

    this.recordsEl.appendChild(li);

    this.recordsEl.scrollTop = this.recordsEl.scrollHeight;
  },

  getNodeFront: Task.async(function*(node) {
    // Set, via the frame-script, the provided node as the "inspecting node" on
    // the inspector module. This way we can later retrieve it via the walker
    // actor.
    this.mm.sendAsyncMessage("PageRecorder:SetInspectingNode", null, {node});

    // Make sure the inspector/waler/highlighter actors are ready
    yield this.toolbox.initInspector();

    // Retrieve the node front from the walker
    return this.toolbox.walker.findInspectingNode();
  }),

  inspectNode: Task.async(function*(node) {
    let nodeFront = yield this.getNodeFront(node);

    let panel = yield this.toolbox.selectTool("inspector");
    panel.selection.setNodeFront(nodeFront);
  }),

  highlightNode: Task.async(function*(node) {
    let nodeFront = yield this.getNodeFront(node);
    yield this.toolbox.highlighterUtils.highlightNodeFront(nodeFront);
  }),

  unhighlight: Task.async(function*() {
    yield this.toolbox.highlighterUtils.unhighlight();
  }),

  onScreenshot({data}) {
    this.screenshotEl.src = data;
  },

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
    outputEl.textContent = "Event " + data.type;
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
    if (target.classList.length) {
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
  }
};

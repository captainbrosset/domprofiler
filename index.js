"use strict";

const {Cu} = require("chrome");
const self = require("sdk/self");
const {RecorderPanel} = require("data/panel");
const {gDevTools} = Cu.import("resource:///modules/devtools/gDevTools.jsm", {});

gDevTools.registerTool({
  id: "pagerecorder",
  icon: self.data.url("images/icon.svg"),
  invertIconForLightTheme: true,
  url: self.data.url("panel.html"),
  label: "Page Recorder",
  tooltip: "Record mutations and events on the page",

  isTargetSupported(target) {
    return target.isLocalTab;
    // target.client.mainRoot.applicationType returns "operating-system" for b2g
  },

  build(iframeWindow, toolbox) {
    return new RecorderPanel(iframeWindow, toolbox);
  }
});

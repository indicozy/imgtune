import DefaultTheme from "vitepress/theme-without-fonts";
import { defineAsyncComponent } from "vue";
import type { Theme } from "vitepress";
import "./custom.css";
import ReplayViewer from "./components/ReplayViewer.vue";
import DemoApp from "./components/DemoApp.vue";

// The default layout (nav, search, appearance toggle) stays. Pages that need their own look use `layout: page`.
const theme: Theme = {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    // Async so the homepage code (and the survey charts it uses) stays out of every other page.
    app.component("ScanHome", defineAsyncComponent(() => import("./components/ScanHome.vue")));
    app.component("ReplayViewer", ReplayViewer);
    app.component("DemoApp", DemoApp);
  },
};

export default theme;

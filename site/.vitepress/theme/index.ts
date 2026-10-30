import DefaultTheme from "vitepress/theme-without-fonts";
import type { Theme } from "vitepress";
import "./custom.css";
import ScanHome from "./components/ScanHome.vue";
import ReplayViewer from "./components/ReplayViewer.vue";
import DemoApp from "./components/DemoApp.vue";

// The default layout (nav, search, appearance toggle) stays. Pages that need their own look use `layout: page`.
const theme: Theme = {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component("ScanHome", ScanHome);
    app.component("ReplayViewer", ReplayViewer);
    app.component("DemoApp", DemoApp);
  },
};

export default theme;

import DefaultTheme from "vitepress/theme-without-fonts";
import type { Theme } from "vitepress";
import "./custom.css";
import ScanHome from "./components/ScanHome.vue";
import ReplayViewer from "./components/ReplayViewer.vue";
import DemoApp from "./components/DemoApp.vue";
import SurveyStats from "./components/survey/SurveyStats.vue";
import SavingDistribution from "./components/survey/SavingDistribution.vue";
import CategoryBars from "./components/survey/CategoryBars.vue";
import WeightVsSaving from "./components/survey/WeightVsSaving.vue";

// The default layout (nav, search, appearance toggle) stays. Pages that need their own look use `layout: page`.
const theme: Theme = {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component("ScanHome", ScanHome);
    app.component("ReplayViewer", ReplayViewer);
    app.component("DemoApp", DemoApp);
    app.component("SurveyStats", SurveyStats);
    app.component("SavingDistribution", SavingDistribution);
    app.component("CategoryBars", CategoryBars);
    app.component("WeightVsSaving", WeightVsSaving);
  },
};

export default theme;

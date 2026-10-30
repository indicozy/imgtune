import { defineConfig } from "vitepress";

const REPO = "https://github.com/indicozy/imgtune";

export default defineConfig({
  base: "/imgtune/",
  lang: "en-US",
  title: "ImgTune",
  titleTemplate: ":title | ImgTune",
  description:
    "Your images waste your traffic. ImgTune measures size, quality and format together on your live page, at six viewports, and gives the fix.",
  cleanUrls: false,
  appearance: true,
  lastUpdated: false,
  head: [
    ["link", { rel: "icon", href: "/imgtune/favicon.svg", type: "image/svg+xml" }],
    ["meta", { name: "theme-color", content: "#0B0F10" }],
    ["link", { rel: "preconnect", href: "https://fonts.googleapis.com" }],
    ["link", { rel: "preconnect", href: "https://fonts.gstatic.com", crossorigin: "" }],
    [
      "link",
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=Geist:wght@400;500;600&family=Geist+Mono:wght@400;500;600&display=swap",
      },
    ],
  ],
  vite: {
    build: {
      // Keep the demo's WASM as separate files: the codecs must never be inlined into JS.
      assetsInlineLimit: 0,
    },
    worker: {
      format: "es",
    },
  },
  themeConfig: {
    siteTitle: "ImgTune",
    nav: [
      { text: "Demo", link: "/demo" },
      { text: "Replay", link: "/replay" },
      { text: "Guide", link: "/guide/", activeMatch: "/guide/" },
      { text: "Reference", link: "/reference/", activeMatch: "/reference/" },
      { text: "Study", link: "/study/", activeMatch: "/study/" },
      { text: "GitHub", link: REPO },
    ],
    sidebar: {
      "/guide/": [
        {
          text: "Guide",
          items: [
            { text: "Getting started", link: "/guide/getting-started" },
            { text: "Scanning any site", link: "/guide/scanning-any-site" },
            { text: "Next.js workflow", link: "/guide/nextjs-workflow" },
            { text: "Image loaders and CDNs", link: "/guide/loaders-and-cdns" },
            { text: "How it measures", link: "/guide/how-it-measures" },
            { text: "CI action", link: "/guide/ci-action" },
            { text: "Agent skill", link: "/guide/agent-skill" },
            { text: "Limitations and FAQ", link: "/guide/limitations-and-faq" },
            { text: "Compared with other tools", link: "/guide/compared-with-other-tools" },
          ],
        },
      ],
      "/reference/": [
        {
          text: "Reference",
          items: [
            { text: "CLI commands and flags", link: "/reference/cli" },
            { text: "Output JSON fields", link: "/reference/output-json" },
            { text: "Configuration", link: "/reference/configuration" },
          ],
        },
      ],
      "/study/": [
        {
          text: "Study",
          items: [{ text: "Results and method", link: "/study/" }],
        },
      ],
    },
    socialLinks: [{ icon: "github", link: REPO }],
    search: {
      provider: "local",
    },
    outline: { level: [2, 3], label: "On this page" },
    docFooter: { prev: "Previous", next: "Next" },
    footer: {
      message: "MIT License. Third-party code is listed in NOTICE.",
      copyright: "made by @indicozy",
    },
  },
});

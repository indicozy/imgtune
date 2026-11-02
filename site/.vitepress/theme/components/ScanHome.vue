<script setup lang="ts">
import { ref } from "vue";
import DropTarget from "./DropTarget.vue";
import ReplayViewer from "./ReplayViewer.vue";
import WidthPicker from "./WidthPicker.vue";
import SurveyStats from "./survey/SurveyStats.vue";
import SavingDistribution from "./survey/SavingDistribution.vue";
import survey from "../../../data/survey.json";

const CMD = "npx imgtune scan https://your-site";
const copied = ref(false);

function copy() {
  if (!navigator.clipboard) return;
  navigator.clipboard.writeText(CMD).then(
    () => {
      copied.value = true;
      setTimeout(() => (copied.value = false), 1200);
    },
    () => {},
  );
}
</script>

<template>
  <div class="home">
    <section class="hero">
      <div class="hero-copy">
        <p class="kicker">scan · 6 viewports · 2 pages · SSIMULACRA2 delta 2</p>
        <h1 class="scan-h1">Get the exact <code>sizes</code> and quality for every image. <span class="fix">Find the line that renders it, and prove nobody can see the change.</span></h1>
        <p class="lede">
          Lighthouse tells you your images are too big. ImgTune measures every image on the live page at six viewports, gives the
          <code>sizes</code>, quality and format to set, and checks each quality target with SSIMULACRA2. Run against your dev server,
          it also points at the component, file and line that renders each image. Your coding agent applies the fix, and a rescan
          checks it. Open source, MIT.
        </p>
        <p class="fine">
          Works with your image CDN. Cloudinary, imgix and <code>next/image</code> resize to whatever width <code>sizes</code> asks for,
          so a wrong <code>sizes</code> is waste no CDN removes.
        </p>
        <p class="fine">Built for image-heavy sites: e-commerce catalogs, media, marketplaces.</p>
        <div class="cmd">
          <span><span class="p">$</span> npx imgtune scan https://your-site</span>
          <button type="button" @click="copy">{{ copied ? "copied" : "copy" }}</button>
        </div>
        <p class="fine">Nothing leaves your machine except the requests your own site makes.</p>
        <p class="links">
          <a href="/imgtune/guide/getting-started">Getting started</a>
          <a href="/imgtune/demo">Open the demo</a>
          <a href="https://github.com/indicozy/imgtune">Source on GitHub</a>
        </p>
      </div>
      <DropTarget />
    </section>

    <section class="steps" aria-label="How it works">
      <ol>
        <li><span class="n">1</span><p><strong>Scan</strong> loads each page at six viewports and records every image.</p></li>
        <li><span class="n">2</span><p><strong>Hints</strong> give each image its sizes, quality and format, the bytes each fix saves, and, when they resolve, the file and line in your source.</p></li>
        <li><span class="n">3</span><p><strong>Your agent fixes it</strong> in your source, and a rescan checks every change.</p></li>
      </ol>
    </section>

    <section id="ways" class="blk">
      <div class="sec-head">
        <h2 class="scan-h2">Two ways to measure.</h2>
        <span class="idx">01 / check and audit</span>
      </div>
      <div class="ways">
        <article class="way">
          <b>check</b>
          <div class="cmd"><span><span class="p">$</span> npx imgtune check https://your-site</span></div>
          <p>
            The production check, in a browser only, for any live site, yours or a prospect's. It surveys the site's sitemap, groups
            pages by route type and deep-scans the heaviest page of each type. The report is a ready Markdown file for performance
            agencies and consultants.
          </p>
        </article>
        <article class="way">
          <b>audit</b>
          <div class="cmd"><span><span class="p">$</span> npx imgtune audit --app . --prod http://localhost:3000</span></div>
          <p>
            The deep mode for your own Next.js app. It reads the app's routes and <code>next.config</code>, measures the production
            build, and with <code>--dev</code> locates each fix at its file and line in the source.
          </p>
        </article>
      </div>
      <p class="fine">
        In CI, the <a href="/imgtune/guide/ci-action">GitHub Action</a> comments on each pull request with the image weight of
        each page, its savings and the top fix hints, and can fail the job above a <code>fail-over</code> budget.
      </p>
    </section>

    <section id="replay" class="blk">
      <div class="sec-head">
        <h2 class="scan-h2">Scan replay.</h2>
        <span class="idx">02 / fresh scans of five open-source sites</span>
      </div>
      <ReplayViewer />
    </section>

    <section id="widths" class="blk">
      <div class="sec-head">
        <h2 class="scan-h2">Width, per viewport.</h2>
        <span class="idx">03 / layout presets or a sizes value</span>
      </div>
      <p class="intro">
        An image is only as big as the pixels its slot needs. Pick how the image is laid out, and the table gives the device
        pixels it needs at each of the CLI's six viewports. The demo scores the encodings at those widths.
      </p>
      <WidthPicker />
    </section>

    <section id="why" class="blk">
      <div class="sec-head">
        <h2 class="scan-h2">One lever is not enough.</h2>
        <span class="idx">04 / size, quality, format</span>
      </div>
      <p class="intro">An image is as heavy as its pixels, its quality and its format together. Fix one and the other two keep the waste.</p>
      <ol class="levers">
        <li><span class="n">1</span><p><strong>Compressors</strong> squeeze the file you hand them, but never learn how wide it is shown. A 6,000&nbsp;px logo in a 150&nbsp;px slot stays 6,000&nbsp;px, only better compressed.</p></li>
        <li><span class="n">2</span><p><strong>Image CDNs and <code>next/image</code></strong> resize on request, but only to the widths your <code>sizes</code> attribute asks for. Get <code>sizes</code> wrong, or leave it out, and the browser fetches a file several times too wide, on every phone.</p></li>
        <li><span class="n">3</span><p><strong>Lighthouse</strong> flags oversized, poorly encoded and old-format images, at one viewport per run, with a fixed estimate. It tells you something is wrong; it does not tell you which <code>sizes</code> or quality to set.</p></li>
        <li class="us"><span class="n">&rarr;</span><p>ImgTune measures <strong>size, quality and format together</strong>, per image, on the live page at six viewports. Every candidate is checked with SSIMULACRA2, so a saving only counts when nobody can see the difference. ImgTune does not edit your code: your AI agent makes the change from the hint, and a rescan checks it. That works in any framework.</p></li>
      </ol>
      <div class="survey-home">
        <p class="survey-line">
          <span class="survey-kicker">survey</span>
          <span>{{ survey.count }} production sites on many stacks, anonymous. The median site could cut its image bytes by {{ survey.summary.medianExactEstPct.toFixed(1) }}%.</span>
        </p>
        <SurveyStats :tiles="['medianKb', 'medianSaving', 'share20']" />
        <SavingDistribution compact />
        <a class="survey-go" href="/imgtune/study/#more-sites">See the full survey &rarr;</a>
      </div>
    </section>

    <section id="cta" class="blk cta">
      <div class="sec-head">
        <h2 class="scan-h2">Measure your own pages.</h2>
        <span class="idx">05 / docs</span>
      </div>
      <div class="cta-grid">
        <a href="/imgtune/guide/getting-started"><b>Guide</b><span>Scan a live site, have your agent fix it, and run the scan in CI.</span></a>
        <a href="/imgtune/reference/cli"><b>Reference</b><span>Every command and flag, and the fields of the scan JSON.</span></a>
        <a href="/imgtune/study/"><b>Study</b><span>How the demand study was run, its results, and what it does not prove.</span></a>
      </div>
      <p class="scan-note">Scan replay: fresh scans of 2026-10-30 with imgtune 0.1.0. Study numbers: v4 of 2026-10-28. Browser estimates in the demo are not the CLI's numbers.</p>
    </section>
  </div>
</template>

<style scoped>
.home {
  max-width: 74rem;
  margin: 0 auto;
  padding: 0 1rem 3rem;
  color: var(--scan-ink);
}
.hero {
  display: grid;
  gap: 2rem;
  padding: 2.5rem 0 3rem;
}
.kicker {
  font: 500 0.75rem var(--scan-mono);
  color: var(--scan-accent);
  letter-spacing: 0.06em;
  text-transform: uppercase;
  margin: 0 0 1.25rem;
}
.scan-h1 {
  font-family: var(--scan-display);
  font-weight: 650;
  font-size: clamp(2.6rem, 1.1rem + 5.6vw, 5.25rem);
  line-height: 0.98;
  letter-spacing: -0.025em;
  margin: 0;
}
.fix {
  color: var(--scan-accent);
}
.lede {
  color: var(--scan-muted);
  font-size: 1.0625rem;
  max-width: 34rem;
  margin: 1.25rem 0 0;
}
.cmd {
  margin-top: 1.5rem;
  display: flex;
  align-items: center;
  gap: 0.75rem;
  justify-content: space-between;
  border: 1px solid var(--scan-rule);
  background: var(--scan-panel);
  padding: 0.65rem 0.8rem;
  border-radius: 4px;
  font: 500 0.875rem var(--scan-mono);
  max-width: 34rem;
}
.cmd .p {
  color: var(--scan-accent);
}
.cmd button {
  background: transparent;
  border: 1px solid var(--scan-rule);
  border-radius: 3px;
  font: 500 0.75rem var(--scan-mono);
  color: var(--scan-muted);
  padding: 0.25rem 0.5rem;
  cursor: pointer;
}
.scan-h1 code {
  font-family: var(--scan-mono);
  font-size: 0.6em;
  font-weight: 500;
  letter-spacing: -0.01em;
  line-height: 1;
  padding: 0.12em 0.3em;
  border-radius: 4px;
  background: var(--scan-track);
  color: var(--scan-ink);
  vertical-align: 0.14em;
}
.fine {
  color: var(--scan-muted);
  font-size: 0.9375rem;
  max-width: 34rem;
  margin: 0.75rem 0 0;
}
.fine code,
.intro code,
.way code {
  font-size: 0.875em;
}
.ways {
  display: grid;
  gap: 0.75rem;
  max-width: 60rem;
}
.way {
  border: 1px solid var(--scan-rule);
  background: var(--scan-panel);
  border-radius: 4px;
  padding: 1.1rem;
  display: grid;
  gap: 0.75rem;
  align-content: start;
}
.way b {
  font-family: var(--scan-mono);
  font-weight: 600;
  color: var(--scan-ink);
}
.way p {
  margin: 0;
  color: var(--scan-muted);
  font-size: 0.9375rem;
}
.way .cmd {
  margin-top: 0;
  max-width: none;
}
.links {
  display: flex;
  flex-wrap: wrap;
  gap: 0.6rem 1.25rem;
  margin: 1.25rem 0 0;
  font-weight: 500;
}
.links a,
.cta-grid a b {
  color: var(--scan-ink);
}
.blk {
  border-top: 1px solid var(--scan-rule);
  padding: 3rem 0;
  display: grid;
  gap: 1.25rem;
}
.sec-head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 1rem;
  flex-wrap: wrap;
}
.idx {
  font: 500 0.75rem var(--scan-mono);
  color: var(--scan-accent);
}
.scan-h2 {
  font-family: var(--scan-display);
  font-weight: 600;
  font-size: clamp(1.9rem, 1.3rem + 2vw, 2.75rem);
  letter-spacing: -0.025em;
  line-height: 1;
  margin: 0;
}
.intro {
  color: var(--scan-muted);
  max-width: 46rem;
  margin: 0;
}
.levers {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 0;
}
.levers li {
  display: grid;
  grid-template-columns: 2rem 1fr;
  gap: 0.25rem 0.75rem;
  padding: 1rem 0;
  border-top: 1px solid var(--scan-rule);
  max-width: 46rem;
}
.levers li:last-child {
  border-bottom: 1px solid var(--scan-rule);
}
.levers .n {
  font: 500 0.875rem var(--scan-mono);
  color: var(--scan-accent);
  padding-top: 0.2rem;
}
.levers p {
  margin: 0;
}
.levers li.us p {
  color: var(--scan-ink);
}
.survey-home {
  display: grid;
  gap: 0.9rem;
  max-width: 46rem;
}
.survey-line {
  margin: 0;
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0.4rem 0.9rem;
  font-size: 0.9375rem;
}
.survey-kicker {
  font: 500 0.75rem var(--scan-mono);
  color: var(--scan-accent);
  letter-spacing: 0.06em;
  text-transform: uppercase;
}
.survey-go {
  color: var(--scan-accent);
  font-weight: 500;
  justify-self: start;
}
.steps ol {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 0;
}
.steps li {
  display: grid;
  grid-template-columns: 2rem 1fr;
  gap: 0.25rem 0.75rem;
  padding: 1rem 0;
  border-top: 1px solid var(--scan-rule);
}
.steps li:last-child {
  border-bottom: 1px solid var(--scan-rule);
}
.steps .n {
  font: 500 0.875rem var(--scan-mono);
  color: var(--scan-accent);
  padding-top: 0.2rem;
}
.steps p {
  margin: 0;
  color: var(--scan-muted);
}
.steps strong {
  color: var(--scan-ink);
}
.cta-grid {
  display: grid;
  gap: 0.75rem;
  grid-template-columns: 1fr;
}
.cta-grid a {
  border: 1px solid var(--scan-rule);
  background: var(--scan-panel);
  border-radius: 4px;
  padding: 1rem;
  display: grid;
  gap: 0.4rem;
  text-decoration: none;
}
.cta-grid a:hover {
  border-color: var(--scan-accent);
}
.cta-grid span {
  color: var(--scan-muted);
  font-size: 0.9375rem;
}
@media (min-width: 58rem) {
  .hero {
    grid-template-columns: 1.1fr 0.9fr;
    align-items: start;
  }
  .cta-grid {
    grid-template-columns: repeat(3, 1fr);
  }
  .ways {
    grid-template-columns: repeat(2, 1fr);
  }
}
</style>

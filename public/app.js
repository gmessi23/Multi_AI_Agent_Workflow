"use strict";

const $ = (selector) => document.querySelector(selector);

const els = {
  form: $("#form"),
  query: $("#query"),
  language: $("#language"),
  run: $("#run"),
  count: $("#count"),
  account: $("#account"),
  accountName: $("#account-name"),
  progress: $("#progress"),
  elapsed: $("#elapsed"),
  error: $("#error"),
  errorText: $("#error-text"),
  retry: $("#retry"),
  result: $("#result"),
  summary: $("#summary-text"),
  report: $("#report"),
  followups: $("#followups"),
  notesResearch: $("#notes-research"),
  notesAnalysis: $("#notes-analysis"),
  copy: $("#copy"),
  download: $("#download"),
  print: $("#print"),
};

const STEPS = ["research", "analyze", "write"];
const REQUEST_TIMEOUT_MS = 60000;

let running = false;
let timer = null;
let last = null; // { query, data } for copy / download

/* ---------------------------------------------------------------- helpers */

function show(el, visible) {
  el.hidden = !visible;
}

function setStep(active) {
  const activeIndex = STEPS.indexOf(active); // -1 once everything is "done"
  document.querySelectorAll(".steps li").forEach((li) => {
    const index = STEPS.indexOf(li.dataset.step);
    li.classList.toggle("done", active === "done" || index < activeIndex);
    li.classList.toggle("active", index === activeIndex);
  });
}

function startTimer() {
  const started = Date.now();
  els.elapsed.textContent = "0s";
  timer = setInterval(() => {
    els.elapsed.textContent = `${Math.round((Date.now() - started) / 1000)}s`;
  }, 1000);
}

function stopTimer() {
  clearInterval(timer);
  timer = null;
}

function renderMarkdown(markdown) {
  const text = String(markdown || "");
  if (window.marked && window.DOMPurify) {
    return window.DOMPurify.sanitize(window.marked.parse(text, { gfm: true, breaks: false }));
  }
  // Libraries failed to load: fall back to safe, escaped plain text.
  const p = document.createElement("p");
  p.className = "plain";
  p.textContent = text;
  return p.outerHTML;
}

// Open links from generated content in a new tab, safely.
if (window.DOMPurify) {
  window.DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    if (node.tagName === "A") {
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noopener noreferrer");
    }
  });
}

async function post(path, body) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`/api/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
      // If the Cloudflare Access session has expired, Access answers with a redirect to its
      // login page. Don't follow it (cross-origin, would surface as an opaque network error).
      redirect: "manual",
    });

    if (response.type === "opaqueredirect") {
      throw new Error("Your session has expired. Please reload the page to sign in again.");
    }

    let data = null;
    try {
      data = await response.json();
    } catch (_) {
      /* non-JSON response (e.g. gateway timeout page) */
    }

    if (response.status === 401 || response.status === 403) {
      throw new Error("Your session has expired. Please reload the page to sign in again.");
    }
    if (response.status === 504 || response.status === 408) {
      throw new Error("That step took too long. Please try again, or ask a narrower question.");
    }
    if (!response.ok) {
      throw new Error((data && data.error) || `Request failed (${response.status}).`);
    }
    return data;
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error("That step took too long. Please try again, or ask a narrower question.");
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

/* ------------------------------------------------------------------ auth */

// The whole site sits behind Cloudflare Access, so anyone who can load this page is already
// signed in. We only look up the email to show it next to "Sign out".
async function loadIdentity() {
  try {
    const response = await fetch("/cdn-cgi/access/get-identity", { cache: "no-store" });
    if (!response.ok) return;
    const identity = await response.json();
    if (identity && identity.email) {
      els.accountName.textContent = identity.email;
      show(els.account, true);
    }
  } catch (_) {
    /* Not behind Access (e.g. local `wrangler dev`): just leave the account badge hidden. */
  }
}

/* -------------------------------------------------------------- pipeline */

async function generate(query) {
  if (running) return;
  running = true;
  els.run.disabled = true;
  show(els.error, false);
  show(els.result, false);
  show(els.progress, true);
  startTimer();

  const french = els.language.value === "fr";

  try {
    setStep("research");
    const research = await post("research", { query });

    setStep("analyze");
    const analysis = await post("analyze", { research_summary: research.research_summary });

    setStep("write");
    const report = await post("write", {
      query,
      research_summary: research.research_summary,
      analysis_summary: analysis.analysis_summary,
      french,
    });

    setStep("done");
    last = { query, data: { ...report, ...research, ...analysis } };
    renderResult(last);
  } catch (err) {
    els.errorText.textContent = err.message || "Unexpected error.";
    show(els.error, true);
  } finally {
    stopTimer();
    running = false;
    els.run.disabled = false;
    show(els.progress, false);
  }
}

function renderResult({ data }) {
  els.summary.textContent = data.short_summary;
  els.report.innerHTML = renderMarkdown(data.markdown_report);
  els.notesResearch.innerHTML = renderMarkdown(data.research_summary);
  els.notesAnalysis.innerHTML = renderMarkdown(data.analysis_summary);

  els.followups.replaceChildren();
  (data.follow_up_questions || []).forEach((question) => {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = question;
    button.addEventListener("click", () => {
      els.query.value = question;
      updateCount();
      window.scrollTo({ top: 0, behavior: "smooth" });
      generate(question);
    });
    item.appendChild(button);
    els.followups.appendChild(item);
  });

  show(els.result, true);
  els.result.scrollIntoView({ behavior: "smooth", block: "start" });
}

/* --------------------------------------------------------------- exports */

function buildMarkdown() {
  if (!last) return "";
  const { query, data } = last;
  const questions = (data.follow_up_questions || []).map((q) => `- ${q}`).join("\n");
  return [
    `# ${query}`,
    "",
    `> ${data.short_summary}`,
    "",
    data.markdown_report,
    "",
    "## Follow-up questions",
    questions,
    "",
  ].join("\n");
}

function flash(button, label) {
  const original = button.textContent;
  button.textContent = label;
  setTimeout(() => {
    button.textContent = original;
  }, 1500);
}

els.copy.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(buildMarkdown());
    flash(els.copy, "Copied");
  } catch (_) {
    flash(els.copy, "Copy failed");
  }
});

els.download.addEventListener("click", () => {
  const blob = new Blob([buildMarkdown()], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  const slug = (last ? last.query : "report")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
  link.href = url;
  link.download = `${slug || "report"}.md`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
});

els.print.addEventListener("click", () => window.print());

/* ---------------------------------------------------------------- events */

function updateCount() {
  els.count.textContent = `${els.query.value.length} / 500`;
}

els.query.addEventListener("input", updateCount);

els.query.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
    event.preventDefault();
    els.form.requestSubmit();
  }
});

els.form.addEventListener("submit", (event) => {
  event.preventDefault();
  const query = els.query.value.trim();
  if (query) generate(query);
});

els.retry.addEventListener("click", () => {
  const query = els.query.value.trim();
  if (query) generate(query);
});

document.querySelectorAll(".chip").forEach((chip) => {
  chip.addEventListener("click", () => {
    els.query.value = chip.dataset.q;
    updateCount();
    els.query.focus();
  });
});

updateCount();
loadIdentity();

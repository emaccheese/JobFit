(() => {
  const MIN_WORDS = 200;

  function isVisible(el) {
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function area(el) {
    const rect = el.getBoundingClientRect();
    return rect.width * rect.height;
  }

  // A visible cookie banner is a role="dialog" too; taking it as the root
  // left a few dozen words and no posting. Only a dialog long enough to be
  // one counts.
  function findRoot() {
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"], dialog'))
      .filter(isVisible)
      .filter((d) => window.__jobFit.textFrom(d).split(/\s+/).length >= MIN_WORDS);
    if (dialogs.length > 0) {
      dialogs.sort((a, b) => area(b) - area(a));
      return dialogs[0];
    }
    return document.body;
  }

  // Section headings postings have and other long pages rarely do, in the
  // four languages. Each group counts once, and only as a heading: a short
  // line that starts with it, so a profile or an article that mentions
  // "requirements" in a sentence doesn't count.
  const POSTING_SECTIONS = [
    // What the job is
    /^(responsibilities|key responsibilities|duties|what you('|’)?ll do|what you will do|your role|the role|about the (role|job|position)|job description|role description|responsabilidades|funciones|tus funciones|qué harás|descripción (del puesto|de la vacante|del empleo)|acerca del puesto|sobre el puesto|responsabilités|vos missions|missions|ce que vous ferez|description du poste|le poste|atribuições|atividades|o que você (vai|irá) fazer|descrição da vaga|sobre a vaga)(?![\p{L}\p{N}])/iu,
    // What it asks for
    /^(requirements|qualifications|minimum qualifications|basic qualifications|preferred qualifications|what you('|’)?ll bring|what you bring|what we('|’)?re looking for|who you are|must have|nice to have|requisitos|requerimientos|perfil (buscado|requerido|del candidato)|lo que buscamos|cualificaciones|exigences|profil recherché|votre profil|compétences requises|qualificações|o que buscamos|perfil desejado)(?![\p{L}\p{N}])/iu,
    // What it offers
    /^(benefits|perks|what we offer|compensation|salary|pay range|beneficios|prestaciones|ofrecemos|lo que ofrecemos|salario|sueldo|avantages|ce que nous offrons|nous offrons|rémunération|salaire|benefícios|oferecemos|o que oferecemos|salário|remuneração)(?![\p{L}\p{N}])/iu,
    // How to get it
    /^(how to apply|apply now|employment type|job type|type of employment|cómo postular|postúlate|tipo de (empleo|contrato|jornada)|modalidad|comment postuler|type de contrat|como se candidatar|candidate-se|tipo de (vaga|contratação))(?![\p{L}\p{N}])/iu,
  ];
  // (The end is checked with Unicode letters, not \b, which treats "é" in
  // "Profil recherché" as a word break.)
  const MAX_HEADING_CHARS = 60;

  function looksLikePosting(text) {
    if (typeof JOB_FIT_META !== "undefined" && JOB_FIT_META.jsonLdNodes().length > 0) return true;
    const headings = text
      .split("\n")
      .map((line) => line.trim().replace(/[:：]$/, ""))
      .filter((line) => line && line.length <= MAX_HEADING_CHARS);
    const found = POSTING_SECTIONS.filter((section) => headings.some((line) => section.test(line)));
    return found.length >= 2;
  }

  // LinkedIn's job pages have their own reader. Anything else there (a
  // profile, the feed, a company page) is long enough to pass for a posting
  // and full of the words one uses, so it's never read as one.
  function isLinkedInNonJobPage() {
    return /(^|\.)linkedin\.com$/.test(location.hostname) && !/^\/jobs\//.test(location.pathname);
  }

  // "Evaluate anyway" on the "No posting found" notice reads this page as it
  // is, for a real posting the checks above miss. Kept for the address it was
  // given on, so the result is still recognised when it comes back. `force`
  // asks whether the page could be read that way, to offer the button.
  function extractGeneric({ force = false } = {}) {
    const forced = force || window.__jobFit.forcedPage === location.href;
    if (!forced && isLinkedInNonJobPage()) return null;
    const root = findRoot();

    // Previously this cloned the root to strip forms, then read innerText —
    // but innerText on a detached clone degrades to textContent, so every
    // site falling through to this extractor was getting its <br>/<li>
    // structure flattened into one run-on blob. textFrom does the same
    // skipping (forms included, so the PII guarantee holds) while walking
    // the live DOM, where block boundaries are preserved.
    const text = window.__jobFit.textFrom(root);
    if (text.split(/\s+/).length < MIN_WORDS) return null;
    if (!forced && !looksLikePosting(text)) return null;

    return {
      title: document.title || null,
      company: null,
      location: null,
      text,
    };
  }

  window.__jobFit = window.__jobFit || {};
  window.__jobFit.generic = extractGeneric;
})();

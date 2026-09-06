// Popout window renderer — receives live snapshots from the main MultiRP
// window and renders them as if a friend were looking at your Discord profile.
//
// All data comes via window.multirp.onPopoutSnapshot(...) bridged in preload.
// We never reach Discord directly here; URLs are pre-resolved by the parent.

(function () {
  const $ = (id) => document.getElementById(id);

  function setImage(el, url, fallbackGradient, hasImageClass) {
    if (!el) return;
    el.classList.remove('has-image');
    if (url) {
      const probe = new Image();
      probe.onload = () => {
        el.style.background = `center / cover no-repeat url("${url}")`;
        if (hasImageClass) el.classList.add('has-image');
      };
      probe.onerror = () => {
        el.style.background = fallbackGradient;
      };
      probe.src = url;
    } else {
      el.style.background = fallbackGradient;
    }
  }

  function render(snap) {
    if (!snap) return;
    $('popActivityVerb').textContent = snap.activityVerb || 'Playing';
    $('popAppName').textContent = snap.appName || 'App name';
    // v1.9.9.1 — Hyperlink Fields. If a URL is set on details/state, render
    // them as clickable links. Otherwise, fall back to plain text.
    renderTextOrLink($('popDetails'), snap.details, snap.detailsUrl);
    renderTextOrLink($('popState'), snap.state, snap.stateUrl, snap.party);
    $('popElapsed').textContent = snap.elapsed || '';

    // Username header — uses the app name as a stand-in identity.
    $('popoutUsername').textContent = snap.appName || 'You';
    $('popoutHandle').textContent = snap.isLive ? '· live now' : '· preview';
    const liveDot = $('liveDot');
    if (liveDot) {
      if (snap.isLive) liveDot.removeAttribute('hidden');
      else liveDot.setAttribute('hidden', '');
    }

    const large = $('popLarge');
    const small = $('popSmall');
    const avatar = $('popoutAvatar');
    setImage(
      large,
      snap.largeUrl,
      snap.largeUrl ? 'linear-gradient(135deg,#5563d4,#7c8cff)' : 'var(--bg-3)',
      true
    );
    // Re-use the large image for the avatar since you typically design that
    // as your "icon" — gives the popout a sense of identity.
    setImage(
      avatar,
      snap.largeUrl,
      'linear-gradient(135deg,#5563d4,#7c8cff)',
      false
    );

    if (snap.smallUrl) {
      small.classList.add('visible');
      setImage(
        small,
        snap.smallUrl,
        'linear-gradient(135deg,#7c8cff,#5563d4)',
        false
      );
    } else {
      small.classList.remove('visible');
      small.style.background = '';
    }

    large.title = snap.largeTooltip || '';
    small.title = snap.smallTooltip || '';

    // v1.9.9.1 — Hyperlink Fields. Make the popout images clickable when
    // the parent forwarded a valid URL.
    applyImageLinkPopout(large, snap.largeImageUrl);
    applyImageLinkPopout(small, snap.smallImageUrl);

    const btnsEl = $('popButtons');
    btnsEl.innerHTML = '';
    (snap.buttons || []).forEach((b) => {
      const el = document.createElement('div');
      el.className = 'popout-button';
      el.textContent = b.label;
      el.title = `${b.label} — ${b.url}\nClick to open in browser`;
      el.onclick = () => {
        if (b.url && /^https?:\/\//i.test(b.url) && window.multirp && window.multirp.openExternal) {
          window.multirp.openExternal(b.url);
        }
      };
      btnsEl.appendChild(el);
    });
  }

  // v1.9.9.1 — popout-side helpers for hyperlink rendering.
  function renderTextOrLink(el, text, url, suffix) {
    if (!el) return;
    el.innerHTML = '';
    el.classList.remove('hyperlink');
    const display = text || '—';
    if (text && url && /^https?:\/\//i.test(url)) {
      const a = document.createElement('a');
      a.href = '#';
      a.textContent = display;
      a.title = url;
      a.className = 'preview-link';
      a.onclick = (e) => {
        e.preventDefault();
        if (window.multirp && window.multirp.openExternal) window.multirp.openExternal(url);
      };
      el.appendChild(a);
      el.classList.add('hyperlink');
    } else {
      el.appendChild(document.createTextNode(display));
    }
    // Party size ("(1 of 1)"), plain text appended after State, same as Discord.
    if (suffix && text) {
      el.appendChild(document.createTextNode(' ' + suffix));
    }
  }
  function applyImageLinkPopout(el, url) {
    if (!el) return;
    el.onclick = null;
    el.classList.remove('hyperlink');
    el.style.cursor = '';
    if (!url || !/^https?:\/\//i.test(url)) return;
    el.classList.add('hyperlink');
    el.style.cursor = 'pointer';
    el.onclick = (e) => {
      e.preventDefault();
      if (window.multirp && window.multirp.openExternal) window.multirp.openExternal(url);
    };
  }

  // Wire up the close button
  document.getElementById('popoutClose').onclick = () => {
    if (window.multirp && window.multirp.closePopout) {
      window.multirp.closePopout();
    } else {
      window.close();
    }
  };

  // Subscribe to snapshots from the parent renderer
  if (window.multirp && window.multirp.onPopoutSnapshot) {
    window.multirp.onPopoutSnapshot((snap) => render(snap));
  }

  // Tell the parent we're ready so it can push the first snapshot.
  if (window.multirp && window.multirp.popoutReady) {
    window.multirp.popoutReady();
  }
})();

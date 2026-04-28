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
    $('popDetails').textContent = snap.details || '—';
    $('popState').textContent = snap.state || '—';
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

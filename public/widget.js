/**
 * WYA Vendor Discovery Widget
 * Embed live vendor listings on any website
 *
 * Usage:
 *   <div id="wya-widget"></div>
 *   <script src="https://wya.digisigns.link/widget.js" data-category="food_truck"></script>
 */
(function() {
  'use strict';
  var BASE = 'https://wya.digisigns.link';
  var script = document.currentScript;
  var category = script ? script.getAttribute('data-category') : '';
  var limit = parseInt(script ? script.getAttribute('data-limit') : '6') || 6;
  var theme = (script ? script.getAttribute('data-theme') : 'dark') || 'dark';

  var container = document.getElementById('wya-widget');
  if (!container) {
    container = document.createElement('div');
    container.id = 'wya-widget';
    script.parentNode.insertBefore(container, script.nextSibling);
  }

  var isDark = theme === 'dark';
  var bg = isDark ? '#0A0A0A' : '#FFFFFF';
  var cardBg = isDark ? '#141414' : '#F8F9FA';
  var text = isDark ? '#F5F5F5' : '#1A1A1A';
  var muted = isDark ? 'rgba(255,255,255,.55)' : '#666';
  var border = isDark ? 'rgba(255,255,255,.07)' : '#E5E5E5';
  var accent = '#FF5E1A';

  container.innerHTML = '<div style="font-family:system-ui,sans-serif;padding:16px;background:'+bg+';border-radius:16px;border:1px solid '+border+'"><div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px"><span style="font-size:16px;font-weight:800;color:'+text+'">Live on <span style="color:'+accent+'">WYA</span></span><span style="font-size:11px;color:'+muted+'">Loading...</span></div><div id="wya-vendor-list" style="display:grid;gap:8px"></div><div style="text-align:center;margin-top:12px"><a href="'+BASE+'/customer" target="_blank" style="display:inline-block;padding:10px 20px;background:'+accent+';color:#fff;border-radius:10px;text-decoration:none;font-weight:700;font-size:13px">See All Vendors</a></div></div>';

  fetch(BASE + '/api/vendors/live' + (category ? '?category=' + category : ''))
    .then(function(r) { return r.json(); })
    .then(function(data) {
      var vendors = (data.vendors || data || []).slice(0, limit);
      var list = document.getElementById('wya-vendor-list');
      var statusEl = container.querySelector('span:last-child');
      if (statusEl) statusEl.textContent = vendors.length + ' live now';

      if (vendors.length === 0) {
        list.innerHTML = '<div style="text-align:center;padding:20px;color:'+muted+';font-size:13px">No vendors live right now. Check back soon!</div>';
        return;
      }

      list.innerHTML = vendors.map(function(v) {
        var cat = (v.category || 'other').replace(/_/g, ' ');
        return '<a href="'+BASE+'/customer?vendor='+v.id+'" target="_blank" style="display:flex;align-items:center;gap:12px;padding:12px;background:'+cardBg+';border:1px solid '+border+';border-radius:12px;text-decoration:none;transition:border-color .15s" onmouseover="this.style.borderColor=\''+accent+'\'" onmouseout="this.style.borderColor=\''+border+'\'">' +
          '<div style="width:40px;height:40px;border-radius:10px;background:rgba(255,94,26,.1);display:flex;align-items:center;justify-content:center;font-size:20px;flex-shrink:0">' + (v.photo_url ? '<img src="'+BASE+v.photo_url+'" style="width:40px;height:40px;border-radius:10px;object-fit:cover">' : '📍') + '</div>' +
          '<div style="flex:1;min-width:0"><div style="font-size:14px;font-weight:700;color:'+text+';white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + (v.name || 'Vendor') + '</div><div style="font-size:11px;color:'+muted+';text-transform:capitalize">' + cat + '</div></div>' +
          '<div style="width:8px;height:8px;border-radius:50%;background:#22C55E;flex-shrink:0" title="Live now"></div>' +
        '</a>';
      }).join('');
    })
    .catch(function(e) {
      var list = document.getElementById('wya-vendor-list');
      if (list) list.innerHTML = '<div style="text-align:center;padding:20px;color:'+muted+';font-size:13px">Unable to load vendors.</div>';
    });
})();

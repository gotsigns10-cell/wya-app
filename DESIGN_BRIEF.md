# WYA Design Refresh Brief
## Priority: HIGH | Target: Week 1-2
## Created: 2026-10-23

---

## Current State (Quantified)

| Issue | Count | Target |
|-------|-------|--------|
| Emoji instances | 79 | 0 (replace with SVG icons) |
| Gradient declarations | 31 | 3-4 (primary, secondary, accent, disabled) |
| Border-radius values | 18 different | 4 (sm: 4px, md: 8px, lg: 16px, full: 9999px) |
| Keyframe animations | 21 | 5-6 max (enter, exit, pulse, spin, slide, fade) |
| Visible tabs (vendor) | 13+ | 5 + overflow menu |

---

## Design Direction

**Style**: "Modern utility" — not "startup energy"
**Reference apps**:
- Apple Maps (iOS) — clean map UI, bottom sheets
- Stripe Dashboard — professional SaaS feel
- Linear — minimal, focused, dark-first

**Constraints (locked)**:
- Dark-first design
- Primary accent: #00D4AA (teal) — DO NOT CHANGE
- Web-first PWA (must work in mobile Safari)
- Mapbox GL JS for maps

---

## Token System (CSS Variables)

Create unified design tokens in soul-ui-v2.css:

```css
:root {
  /* Spacing */
  --space-xs: 4px;
  --space-sm: 8px;
  --space-md: 16px;
  --space-lg: 24px;
  --space-xl: 32px;
  --space-2xl: 48px;

  /* Border Radius */
  --radius-sm: 4px;
  --radius-md: 8px;
  --radius-lg: 16px;
  --radius-full: 9999px;

  /* Colors (locked) */
  --color-accent: #00D4AA;
  --color-accent-hover: #00E5BB;
  --color-bg-primary: #0F1419;
  --color-bg-secondary: #1A1F26;
  --color-bg-elevated: #252B33;
  --color-text-primary: #FFFFFF;
  --color-text-secondary: #8B95A1;
  --color-border: #2E363F;
  --color-error: #EF4444;
  --color-warning: #F59E0B;
  --color-success: #10B981;

  /* Typography */
  --font-sans: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
  --font-mono: 'SF Mono', Menlo, monospace;

  /* Shadows */
  --shadow-sm: 0 1px 2px rgba(0,0,0,0.3);
  --shadow-md: 0 4px 12px rgba(0,0,0,0.4);
  --shadow-lg: 0 8px 24px rgba(0,0,0,0.5);

  /* Transitions */
  --transition-fast: 150ms ease;
  --transition-normal: 250ms ease;
  --transition-slow: 400ms ease;
}
```

---

## Component Redesign Specs

### 1. Vendor Card (Map Popup)
**Current**: Overstuffed with emojis, gradients, too much info
**Target**:
- Photo + name + category tag only
- Rating stars (no number)
- Single CTA: "View Menu"
- Distance badge (top-right corner)
- Progressive disclosure: tap to expand

### 2. Navigation (Vendor Dashboard)
**Current**: 13 visible tabs overwhelming
**Target**: 5 primary tabs + "More" overflow
- Dashboard (home)
- Orders
- Menu
- Analytics
- Settings
- More: Social, Ambassador, Hours, Integrations, etc.

### 3. Map Bottom Sheet (Customer)
**Current**: Glassmorphism everywhere, competing with map
**Target**:
- Solid dark background (#1A1F26)
- Subtle top shadow only
- Pull handle: 4px x 36px rounded bar
- Search at top (sticky)
- Vendor list below (simple cards)

### 4. Order Cards
**Current**: Gradient backgrounds, emoji status
**Target**:
- Status pill with icon (Pending, Preparing, Ready, Delivered)
- Clean typography hierarchy
- Vendor photo (small, rounded square)
- Time + price right-aligned

---

## Icon Replacement

Replace ALL emojis with SVG icons. Use:
- Heroicons Solid (https://heroicons.com)
- Or create custom 24x24 SVGs

| Current | Replace With |
|---------|--------------|
| Location pins | Map marker SVG |
| Checkmarks | Check circle SVG |
| Stars | Star SVG |
| Time/clock | Clock SVG |
| Money | Currency/card SVG |
| Warning | Exclamation triangle SVG |
| User | User circle SVG |
| Settings | Cog SVG |
| Menu items | Grid or list SVG |

---

## Animation Guidelines

Keep only these animations:
1. **fade-in**: opacity 0 -> 1, 200ms
2. **slide-up**: translateY(20px) -> 0, 250ms
3. **scale-in**: scale(0.95) -> 1, 200ms (for modals)
4. **pulse**: opacity cycling (for loading states only)
5. **spin**: rotate 360deg (for spinners only)

Remove:
- Bouncing elements
- Waving text
- Shimmer effects on static elements
- Any animation that loops indefinitely

---

## Files to Modify

1. `/root/universoul-ecosystem/wya-app/public/customer.html` — 66K tokens
2. `/root/universoul-ecosystem/wya-app/public/vendor.html` — 85K tokens
3. `https://static.digisigns.link/soul-ui-v2.css` — shared token system

---

## Deliverables Checklist

| Deliverable | Status |
|-------------|--------|
| Design tokens CSS file | [ ] |
| SVG icon set (20+ icons) | [ ] |
| Vendor card component redesign | [ ] |
| Navigation consolidation | [ ] |
| Bottom sheet redesign | [ ] |
| Order card redesign | [ ] |
| 1024x1024 app icon | [ ] |
| App Store screenshots (6 frames) | [ ] |

---

## Timeline

- Day 1-2: Token system + icon set
- Day 3-4: Component redesigns
- Day 5: Screenshots + app icon
- Day 6: Integration + testing
- Day 7: Visual QA via VNC crawl

---

## Notes

- Do NOT change functionality — design refresh only
- Keep all existing API calls intact
- Test on iOS Safari (primary target)
- Run `crawl_card https://wya.digisigns.link` after changes

# Responsive UI Verification Checklist

## Breakpoints

- **Mobile:** ≤ 640px
- **Tablet:** 641–1024px
- **Desktop:** ≥ 1025px

## Changes Summary

### Global
- Viewport meta: `width=device-width, initial-scale=1, viewport-fit=cover` in `_document.tsx`
- Base font 16px; inputs `font-size: 16px` on mobile (prevents iOS zoom)
- Touch targets: `min-height: 44px` for buttons/links/inputs on mobile
- `.responsive-page`: reduced padding on mobile

### /public
- Pad grid: 1 col (mobile) → 2 col (tablet) → 4 col (desktop)
- Header: stacks vertically on mobile; smaller logo
- Enter Kiosk: full-width at bottom with safe-area padding on mobile

### /judge
- Layout: 1 col (mobile) → 2 col (tablet, tools hidden) → 3 col (desktop)
- Tools column hidden on tablet; Show Tools toggle visible

### /admin
- Header: stacks on mobile
- Broadcast row: single column on mobile
- Comm layout (channels + chat): stacked on mobile
- Dashboard cards (dash3): 1 col (mobile) → 2 col (tablet) → 3 col (desktop)
- Area rows: flex column on mobile

### /login
- Inputs/button: `min-height: 44px`, `font-size: 16px`

## Verification

### iPhone Safari
- [ ] No horizontal scroll
- [ ] Text readable without pinch zoom
- [ ] Buttons easy to tap (≥ 44px)
- [ ] All controls present and functional
- [ ] Enter Kiosk button visible, not covering content
- [ ] Pad cards stack vertically on /public

### iPad
- [ ] 2-column layout where appropriate (pad grid, judge main area)
- [ ] No horizontal scroll
- [ ] Touch targets adequate

### Desktop
- [ ] Layout unchanged or improved
- [ ] No loss of density
- [ ] All features work

### General
- [ ] No console errors
- [ ] No new dependencies added

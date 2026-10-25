# Gavel - design spec (v2)

Design read: live auction product for crypto-native reviewers and casual bidders, with an
auction-floor / trading-terminal language, leaning toward Tailwind v3 (existing) + Geist +
Motion. Redesign mode: OVERHAUL visuals, PRESERVE routes, nav labels, contract logic,
every data flow and every existing feature.

Dials: DESIGN_VARIANCE 6, MOTION_INTENSITY 6, VISUAL_DENSITY 5. The clock and the
current bid are the hero of every lot page. Motion exists to communicate state changes
(new bid, clock extended, outbid, hammer), never for decoration.

## 1. Tokens (CSS variables in src/index.css, one place only)

Theme: dark by default, with a light mode (section 1b). Whichever is active applies to
the whole page; no section ever flips theme on its own.

| Token | Value | Use |
|---|---|---|
| --bg | #0E0E0C | page (warm graphite, not pure black, not navy) |
| --surface | #161613 | raised panels |
| --surface-2 | #1E1E1A | inputs, hovered rows |
| --line | #2A2A25 | hairlines, 1px borders |
| --ink | #F2F1EC | primary text (not pure white) |
| --ink-2 | #B9B7AE | secondary text (must pass 4.5:1 on --bg) |
| --ink-3 | #7E7C73 | tertiary / timestamps (large text only) |
| --accent | #FF6B2C | THE single accent: hammer orange. CTAs, live clock, extensions |
| --accent-ink | #140A04 | text on accent buttons |
| --good | #3FB97A | ONLY for "you are winning" and successful claim |
| --warn | #E5B54A | ONLY for "clock extended" flash and bond-held |

Rules: one accent everywhere. No blue anywhere (retire #acc6e9 and the navy palette).
No gradients on text. Shadows tinted warm: `0 20px 60px -20px rgb(255 107 44 / .18)` for
the live clock panel only; everything else uses hairlines, not shadows.
Grain: one fixed, pointer-events-none noise overlay at 3% opacity (pseudo-element on
body), never on scrolling containers.

### 1b. Light mode (added on request)

Three-way theme: System (default, follows `prefers-color-scheme`), Light, Dark. Set
`data-theme` on `<html>` before first paint (inline script in index.html reading
localStorage `gavel-theme`, wrapped in try/catch) so there is no flash. Every colour in
components comes from the tokens; only the token values change.

| Token | Light value |
|---|---|
| --bg | #F3F3F0 |
| --surface | #FBFBF9 |
| --surface-2 | #EBEBE6 |
| --line | #DADAD3 |
| --ink | #161614 |
| --ink-2 | #4A4943 |
| --ink-3 | #6E6C64 |
| --accent | #E8551E (fills: buttons, live clock tag) |
| --accent-text | #B53C0A (accent used AS text/icons on light, passes 4.5:1) |
| --accent-ink | #FFFFFF on accent buttons in light (check 4.5:1; darken --accent if not) |
| --good | #1F8A55 |
| --warn | #A87412 |

In dark mode `--accent-text` equals `--accent`. Grain overlay drops to 2% in light.
Clock shadow uses the accent at lower alpha in light. Check every page in both modes.

Toggle: NOT a sun/moon switch. A small segmented control "System / Light / Dark" in the
desktop nav's right side (before the wallet button) and as a row in a "Display" section
at the bottom of /me on mobile. Phosphor icons Monitor / Sun / Moon at 16px inside the
segments, labels visible to screen readers.

## 2. Type

- Display + UI: **Geist** (500/600/700). Numbers: **Geist Mono** with
  `font-variant-numeric: tabular-nums` for every price, clock, block number and address.
  Self-host via `@fontsource/geist-sans` and `@fontsource/geist-mono` (install them).
  Retire Space Grotesk and JetBrains Mono.
- Scale: clock `text-7xl md:text-8xl` mono, tracking-tight; current bid `text-5xl
  md:text-6xl` mono; page titles `text-3xl md:text-4xl` 600 tracking-tight; body 15-16px,
  max-w-[65ch].
- Sentence case everywhere. Uppercase micro-labels: max ONE per screen (the "Live" tag on
  the lot page). Replace "CURRENT BID", "BID HISTORY", "RECENTLY ENDED", "HOW IT WORKS"
  eyebrows with sentence-case headings or no label.
- Zero em-dashes or en-dashes in any visible string. Use hyphens, commas, periods.

## 3. Shape and icons

- Radius system (documented, applied everywhere): buttons and inputs 10px, panels 16px,
  status tags 6px. No pill-everything, no mixed radii outside this rule.
- Icons: **Phosphor** (`@phosphor-icons/react`, weight "regular", size 18/20). Replace all
  lucide-react imports and remove the lucide dependency. Gavel/hammer icon for the brand
  and the hammer moment, Lightning for gasless, Clock for extensions.
- Favicon: an orange gavel glyph on --bg (generate from the Phosphor Gavel icon as SVG).

## 4. Layout per page

Container: `max-w-[1200px] mx-auto px-4 md:px-8`. Nav: single line, 64px, logo left
("Gavel" wordmark + icon), links center (Lots, Create, Me, Proof) with the active link
marked by an accent underline, wallet button right. Mobile: bottom tab bar (keep), 56px,
with active state.

### Lobby (/)
- Top: a split hero, NOT centered. Left (7 cols): headline "Live auctions, settled in
  USDC." (max 2 lines), one sentence of subtext (max 20 words: "Bid in real time. A late bid
  adds ten seconds. Lot and payment swap in one transaction."), one primary CTA "Bid on the
  house lot" (scrolls/links to the live house lot) and one text link "How settlement
  works" to /proof. Right (5 cols): the LIVE HOUSE LOT as a real embedded mini auction
  panel (title, live clock, current bid, Bid button) - a real component, not a picture.
  If no lot is live: the panel shows "Next house lot starts in a moment" with the last
  settled price. Mobile: stack, panel first.
- Live lots: a responsive grid where the soonest-ending lot is a wide tile (spans 2 cols)
  and the rest are standard tiles. Each tile: title, seller (short address, mono), current
  bid or reserve (mono, large), time left (mono, accent when < 30 s), a "Gasless" tag if
  the lot has relayed bids. No nested cards.
- Ended lots: a compact list (title, hammer price, winner short address, "Settled" or
  "Awaiting settle") with a single hairline between rows, collapsed to the latest 6 with
  a "Show all" button.
- Empty state for live lots: "No live auction right now." + "Create a lot" button. Do NOT
  say "No lots yet" when ended lots exist.
- How it works: three steps in a horizontal row on desktop, each a Phosphor icon + one
  short sentence. No numbered "Step 1/2/3" labels.

### Lot page (/lot/:id) - the signature screen
- Desktop 2 columns (7/5). Left: title, seller, lot description and image (if lotURI has
  one; else a tasteful placeholder from https://picsum.photos/seed/gavel-lot-<id>/1200/800
  in a 3:2 frame), then bid history. Right (sticky top-20): the AUCTION PANEL.
- Auction panel: "Live" tag, the giant mono clock (accent), current bid (mono), leader
  (short address, or "You are winning" in --good), reserve and min step in --ink-2, then
  the Bid button full-width showing the exact amount ("Bid 0.15 USDC"), the gasless toggle
  as a labelled switch ("No gas needed") under it, and a one-line explainer that only
  appears when the clock is under 10 s: "A bid now adds 10 seconds".
- State moments (Motion, spring stiffness 260 damping 24, transform/opacity only,
  all disabled under prefers-reduced-motion):
  1. New bid lands: the current-bid number rolls up digit by digit; the new history row
     slides in from the top.
  2. Clock extended: clock flashes --warn for 600 ms and a "+10 s" chip pops above it.
  3. You are outbid: panel border pulses accent once; banner "You were outbid. 0.15 USDC
     is ready to claim." with a Claim button.
  4. Hammer: clock collapses, gavel icon strikes down once, "Sold for 0.20 USDC" with the
     settlement tx link; if not yet settled, a "Settle" button anyone can press.
- Bid history: rows with amount (mono, --ink), bidder short address (mono, --ink-2),
  relative time, Gasless tag, tx link icon (--ink-3, accent on hover). Readable contrast.
- After hammer for the winner: Confirm delivery / Open dispute buttons, bond status line
  with the 7-day release date.

### Create (/create)
- Single column, max-w-[640px]. Labels above inputs, helper text below, inline errors.
  Live preview tile of the lot on the right on desktop (the real lobby tile component).
  Show the bond amount live as reserve changes ("Bond: 0.10 USDC, returned after
  delivery"). Seller registration as a quiet secondary section at the bottom.
- No wallet: a composed connect prompt, not a blank or disabled form.

### Me (/me)
- Top: claimable USDC as the largest number on the page with one Claim button. Below:
  tabs "Bidding", "Won", "Selling". Reputation as a single line ("3 clean sales, bond
  50%") not a card.

### Proof (/proof)
- Headline "Everything on this page is read from the chain." Four stat figures in a row
  (USDC bid volume, bids, distinct bidders, lots settled) as plain large mono numbers,
  no boxes. Then the event table: event name, lot, amount, address, block, tx link. One
  hairline between groups by block, not under every row. Paused / error states as an
  inline line above the table with the retry countdown.

## 5. States (every page)
Skeletons shaped like the final layout for first load (no spinners). Composed empty
states with one action. Inline errors in plain language ("The relayer did not respond.
Try again or bid with gas."). Hover: background shift to --surface-2; active:
`translate-y-[1px]`; visible focus ring `outline-2 outline-offset-2 outline-[--accent]`.
Skip-to-content link. Custom 404 with a link back to Lots.

## 6. Copy
Plain, active, no exclamation marks, no "seamless/elevate/unleash". Network label comes
from src/chain.ts (NETWORK_LABEL), never hard-coded "Arc Testnet" in components.

## 8. Landing page + screen usage (v3, added 24 Oct)

Problems seen at 1920 px: no landing page (the site opens straight into the tool), a
1200 px column that leaves ~700 px of empty margin, and a page that is mostly blank below
the fold.

### 8.1 Routes
- `/` becomes the LANDING page (marketing, explains the product, has a live demo).
- The current lobby moves to `/lots` (the app's home). Nav "Lots" points to `/lots`.
  `/lot/:id`, `/create`, `/me`, `/proof` unchanged. Old `/` bookmarks land on the
  landing page, which links to `/lots` prominently.
- Landing nav: logo, "How it works" (scrolls to the section), "Proof", theme control,
  and a primary button "Open app" (to /lots). Wallet button only inside the app.

### 8.2 Width
- Container `max-w-[1360px]` with `px-4 md:px-8 xl:px-12` on all app pages.
- Lot grid on /lots: `grid-cols-1 sm:2 lg:3 2xl:4`, soonest-ending lot spans 2 columns
  from `lg`. The ended list sits in a right-hand column from `xl` (8/4 split) instead of
  below everything, so a wide screen shows live and ended at once.
- /lots has NO marketing hero any more (the landing page does that job). Top of /lots:
  page title "Live lots" + a slim house-lot strip (title, clock, current bid, "Bid") +
  the grid. Tool pages are dense; the landing page breathes.

### 8.3 Landing sections (in order; each section a different layout family)
Dials for this page: VARIANCE 7, MOTION 6, DENSITY 3. Section padding `py-24 md:py-32`.
Only ONE eyebrow label on the whole page (the hero). Zero em-dashes. No fake UI built from
divs: every product visual is a REAL component reading real chain data.

1. HERO (split 6/6, `min-h-[calc(100dvh-64px)]`, content vertically centred, fits the
   viewport with the CTA visible at 1366x768):
   - Eyebrow: "Live on Arc" (the only eyebrow on the page).
   - Headline (max 2 lines, text-5xl md:text-6xl, tracking-tight):
     "The auction ends when the bidding does."
   - Subtext (max 20 words): "Every bid is a USDC transaction. A late bid adds ten
     seconds. The lot and the payment swap in one step."
   - CTAs: primary "Bid on a live lot" (to the live house lot, or /lots) with the arrow
     in its own circle inside the button (button-in-button); secondary text link
     "See every transaction" (to /proof).
   - Right: the REAL live house-lot auction panel (same component as the lot page's
     panel, compact variant): live block-timed clock, current bid, leader, Bid button.
     Frame it in a nested "bezel": outer shell `rounded-[22px] p-1.5 bg-surface/60
     ring-1 ring-line`, inner core `rounded-[16px] bg-surface` with an inset top
     highlight. When no house lot is live: show the last result ("Sold for 0.20 USDC",
     or "No bids") and "Next lot in a moment" with a subtle pulse.
2. LIVE NUMBERS (full-width band, no boxes): four large Geist Mono figures read from the
   shared log store: USDC bid volume, bids placed, distinct bidders, lots settled, each
   with a one-word label underneath. Numbers count up once when scrolled into view.
3. WHY ARC (the signature section, split 5/7): left, short headline "Ten seconds only
   means something on a fast chain." and two sentences. Right, a real interactive
   comparison: two horizontal timelines of the final 20 seconds of an auction.
   Top "12-second blocks": the clock moves in 12 s jumps and a late bid at T-4 s lands
   after the close ("Missed"). Bottom "Arc, sub-second blocks": the same late bid lands,
   the bar extends by 10 s ("+10 s"). A Replay button. Animated with transform/opacity
   only, honours reduced motion (shows the end state).
4. HOW A LOT MOVES (horizontal 4-step track, NOT equal cards): List, Bid, Last ten
   seconds, Hammer. Each step: Phosphor icon, a 3-5 word title, one sentence. Connected
   by a hairline that draws itself on scroll. Mobile: vertical stack with the line on
   the left.
5. NO GAS NEEDED (split 7/5, mirrored from section 3): left, a real "Gasless" bid row from
   chain history (latest RelayedBid: amount, bidder short address, "signed, not sent",
   tx link) shown large; right, headline "Bid with one signature." and one sentence on
   the relayer paying gas, plus the live relayed-bid count.
6. BUILT IN THE OPEN (bento, exactly 3 cells, 2+1 layout): big cell "Every event is on
   chain" linking /proof with a mini live event feed (last 5 market events, real);
   cell "Built in Arc Studio" linking the Studio project; cell "Open source" linking the
   GitHub repo. Cells use different surfaces (one with the grain + accent tint).
7. FINAL CTA (centered, the one allowed centered block): "Bring a lot. Or win one." +
   "Open app" button-in-button + "Create a lot" text link.
8. FOOTER: Proof, GitHub, Arc Studio, network label from chain.ts. One line on desktop.

### 8.3.3b Why Arc animation, v2 (replaces the bars + Replay button)

Problem: the comparison only animated when the user pressed Replay, so most visitors
never saw it, and two bars did not show WHY speed matters.

Playback:
- Autoplays when the section is >= 50% visible (IntersectionObserver), plays once, holds
  the final frame 2.5 s, then loops. Pauses when out of view (no background work) and
  while hovered or focused; resumes on leave. "Watch again" small text link restarts it.
- prefers-reduced-motion: no animation; render both lanes in their FINAL state with the
  outcome captions visible.
- One Motion timeline (or a single rAF-driven progress motion value) drives everything,
  so all parts stay in sync; transform/opacity only.

Scene (story time 20 s compressed to ~9 s; both lanes run on the same story clock):
- Two stacked lanes, full width of the right column. Lane label left ("12-second
  blocks" / "Arc, sub-second blocks"), the compact mono countdown right (same component
  style as the real auction panel clock).
- Each lane is a timeline of the final 20 s of an auction with a vertical "close" line
  at T-0. Blocks are drawn as tiles appearing on the timeline as story time passes:
  12-s lane: tiles at T-20 s and T+4 s only (sparse, wide gaps).
  Arc lane: a thin tile every 0.5 s (dense stream).
- Beat 1 (T-10 s): caption "Ten seconds left." Both clocks counting.
- Beat 2 (T-4 s): an accent "bid" dot leaves the left edge of both lanes at the same
  moment. Caption "A bid is sent at four seconds to go."
- Beat 3:
  12-s lane: the dot parks beside the timeline marked "pending" until the next block
  tile at T+4 s, which lands AFTER the close line; the clock reaches 0:00, the dot turns
  --ink-3 and a strike-through, outcome "Missed. Sold to the earlier bid."
  Arc lane: the dot drops into the next tile within ~0.5 s, the clock flashes --warn and
  shows a "+10 s" chip, the close line slides right by 10 s, outcome "Accepted. The
  auction continues."
- Colours: tiles --line (12-s) and --ink-3 (Arc); bid dot --accent; outcomes --ink-3
  (missed) and --good (accepted). Works in both themes.
- Mobile: lanes stack full width; labels above lanes; same timing.
- Accessibility: the section has a visually hidden text summary of the outcome; the
  animation container is aria-hidden.

### 8.4 Motion (motivated only)
Section entry: fade-up 16 px + opacity, 700 ms, `cubic-bezier(0.32,0.72,0,1)`, once,
IntersectionObserver / Motion whileInView. Number count-up in section 2. Timeline replay
in section 3. Line draw in section 4. Hover on CTAs: arrow circle translates +2px x, -1px y.
Everything off under prefers-reduced-motion. No scroll listeners.

### 8.5 Checks
Both themes; 1366x768, 1920x1080, 375x812; hero CTA visible without scrolling at
1366x768; no horizontal scroll; no layout shift while data loads (fixed-size skeletons);
every number on the page comes from chain data, never hard-coded.

## 7. Done means
lint + typecheck clean; all routes render without a wallet; 375 px and 1280 px have no
horizontal scroll; zero lucide imports; zero em-dashes; every price/clock/address in
Geist Mono tabular; one accent colour; all prior features still work (gasless, Memo
settle, claim, confirm/dispute, register seller, proof scanning with backoff).

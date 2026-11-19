# Does reviewing a draft take less time than drawing? A plan for the comparison

Status: **proposed**, 2026-11-19. Nothing here has been run. Every number marked proposed is for the researcher to
set before the first timed section; after that the plan should not change.

## The question

For one section, is the time to reach an approved ROI set shorter when the reviewer starts from the model draft than
when they start from an empty image? And is the approved result the same?

Neither has been measured. The only figure so far is a stated total of 180 minutes for twelve sections of a training
animal over three rounds, which mixes review with tool development and cannot be compared with anything.

## What the site now records

With each approval the page stores the active time spent on that section (gaps between inputs of up to 60 seconds
count, longer pauses and hidden time do not; the cutoff is proposed) and, apart from it, the minutes the reviewer
states for work outside the page, such as in Fiji. See the workflow guide, section "Review time".

## What makes the comparison hard

1. **Memory.** Every analysed section already has a human ROI drawn by the same person. Drawing it again from an
   empty image is faster and different the second time, and reviewing a draft of it is helped by the same memory.
2. **The model has seen most of the material.** Three of the five animals trained the model; the two others have been
   inspected three times.
3. **One reviewer.** A result for one person does not generalise, and that person is not blind to the method.
4. **Sections differ.** Lateral sections take longer than medial ones whichever way they are done.
5. **Two tools.** Editing happens partly in Fiji, where the page cannot measure; that part is only stated.

## Proposed design

**Material.** Sections that have never been outlined. The analysed series is every sixth section, and the sections
between them were the natural source. **Answered by the researcher, 2026-11-19: the sections in between do not exist,
neither as images nor as slides.** Every section of the present animals has therefore already been outlined by the
reviewer, and the comparison below cannot be run on them without the memory problem. Two ways remain:

- *Wait for new animals* (recommended, proposed): time the sections of the next animals as they are reviewed. With
  only every sixth section available, a pair is two consecutive sections of the series (about six section steps
  apart), which differ more than true neighbours; this weakens the pairing and should be said in the result.
- *Use sections already outlined*, stating that memory helps both arms and that the result is a rough indication only.

**Pairs.** Take pairs of neighbouring never-outlined sections of the same animal (in a new animal, consecutive
sections of the series). Within each pair, one section is done from the draft and the other from an empty image,
which arm gets which decided by a coin toss written down before starting. Neighbours are about equally hard, so the
pair removes most of the section-to-section difference.

**How many.** Proposed: 12 pairs, spread over at least three animals and over medial and lateral positions. This is a
number that fits in two or three sittings, not a power calculation; there is no earlier measurement to base one on.

**Order.** Alternate the arms within a sitting, and do not do both sections of a pair one after the other.

**One tool per pair.** Do both sections of a pair in the same tool: either both in the page, or both in Fiji with the
time written down from a stopwatch. Do not mix within a pair.

**What is recorded for each section.**

- arm (draft or empty), animal, section number, date, tool
- active minutes from the approval record, and stated minutes outside the page
- number of ROIs edited, added and deleted (from the review history)
- the approved ROI file

**What is compared.**

- Time: the difference in total minutes within each pair, reported as the median and the range over pairs, with every
  pair shown. No test is planned for 12 pairs from one reviewer; the result is a description.
- Result: there is no second outline of the same section, so agreement cannot be measured directly. Proposed check:
  areas of whole cerebellum, granular layer and white matter, and PL length, should change smoothly from each section
  to its neighbour; report the difference within each pair for both arms and look for a consistent shift in one
  direction (drafts are known to leave no unassigned band between molecular and granular layer).

**What would count as an answer.** Decided before starting, proposed: drafts are worth using if the median saving is
at least a quarter of the drawing time and no pair shows the draft arm taking more than one and a half times the
empty arm. Anything else is reported as it is.

## What this will not show

- Not accuracy: nothing here compares an outline with a truth.
- Not other reviewers, other stains or other laboratories.
- Not the time for a first-time user; the reviewer knows both tools.
- If the page is used, time in Fiji is stated, not measured.

## Decisions needed from the researcher

1. ~~Whether images of unanalysed sections exist.~~ Answered 2026-11-19: they do not. Open instead: wait for new
   animals, or use sections already outlined.
2. The number of pairs and the threshold above.
3. Page or Fiji as the tool for the comparison.
4. Whether to keep the 60 second cutoff.

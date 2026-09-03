# The paperwork nobody bills for

**KevinMD submission, draft v1.** For Eric to rewrite in his own voice and submit.
No product pitch in the body. Byline carries the founder disclosure, which is how KevinMD
handles it.

---

It was a Tuesday night, after a case, and I was trying to renew a medical license.

I had the laptop open on a hotel desk. I had the CME certificates in a folder, more or less. I had about forty minutes before I stopped being useful to anyone. And the portal would not let me in, because in that state the renewal link does not appear until roughly four to six weeks before your license expires, and I was early.

I remember sitting there thinking: I planned for this. I set aside the time. And the system's answer was come back later.

That is the whole thing, really. Not that the work is hard. That it cannot be scheduled.

I work locums, which means I hold licenses in several states, which means I have had a slow education in how differently states think about time. One anchors your expiration to the month your license was issued. One expires every physician in the state on the same fixed day in odd-numbered years. One uses your birthday. One uses whether you were born in an even year or an odd one. None of them coordinate, and there is no reason they would. Each board answers to its own legislature.

The hours are different too. Thirty in one state, forty in another, fifty in a third. And inside a single state the number can change depending on the two letters after your name. In Maine, a DO renews with a different board than an MD, through a different portal, against a different total: one hundred hours per cycle instead of forty. I am a DO. I found that out the way most of us find these things out, which is by looking, late, alone.

None of this is a scandal. It is just a large quantity of small, unlovely, uncompensated work, and it lands hardest on the two groups least able to absorb it.

The first is anyone early in their career. Nobody tells you that your first renewal usually does not arrive when you expect. California gives newer MD licensees a twenty-six month first cycle before settling into twenty-four. Colorado issues you a license that expires on the next statewide April date no matter when you got it, so your first period can be far shorter than two years. Maine's first license runs short for a similar reason. The very first deadline of your professional life is the one you are least equipped to have calibrated, and it arrives while you are still learning to be a doctor.

The second is anyone who moves. Locums physicians, people covering call across state lines, anyone whose career does not sit inside one building. The Interstate Medical Licensure Compact made getting the licenses easier. It did not put them on one clock.

And the failure mode is not a warning. It is a cliff. In Texas, a license expired for a year is cancelled outright, and the way back is not a fee, it is a new application under whatever the requirements happen to be that year. In California there is no grace period at all; the day after expiration the board's public lookup shows you as delinquent, and practicing on it is illegal. In Maine you have ninety days, and after that reinstatement wants evidence of twelve months of active practice or a competency exam. None of these are obscure penalties. They are the ordinary rules, written plainly on the boards' own pages, and most of us have never read them because we have never had to.

Here is what I keep coming back to.

Every hour of this is real work. It requires judgment. It carries real consequence, up to and including not being allowed to see patients. And it is completely invisible. It does not appear in an RVU. It does not appear on a schedule. No one reviews it, no one credits it, and the only time anybody notices it is when it fails.

We have gotten reasonably good, as a profession, at naming the things that grind physicians down. Notes. Inboxes. Prior authorization. This one rarely makes the list, and I think that is because it happens alone, at night, in the gaps, and because it feels like it ought to be trivial. Twenty minutes. A portal. A checkbox.

It is not trivial. It is a second job with no supervisor and no forgiveness, and the people carrying the most of it are the ones with the least slack in their week.

I do not have a policy fix. Boards are not going to synchronize; they answer to fifty different legislatures and they are not wrong to. But I think the honest first step is to stop reading this as a character flaw when it goes wrong. When a colleague's license lapses, the reflex is to assume they were disorganized. Usually they were not. Usually they were tracking four things on four different clocks, and one of the clocks was not the one they thought it was.

The least we can do is say out loud that it is work.

Eric Whitney, DO, is a neurosurgeon and the founder of CredentialDOMD.

---

<!--
NOT PART OF THE SUBMISSION. Verification block for Eric.
Word count of the essay body including byline: see below. KevinMD wants 500 to 1,000.

All state facts from /Users/ew/Projects/CredentialDOMD/landing/states/states-data.json,
meta.verified 2026-08-19.

- "renewal link does not appear until roughly four to six weeks before" (the opening scene,
  Colorado) = states[CO].renewalAnchor. Verified 2026-08, multi-source.
- Four anchor types = states[CA].renewalAnchor (issue month), states[CO].renewalAnchor
  (fixed April 30, odd years), states[ND].renewalAnchor (birthday), states[ME].renewalAnchor
  (birth-year parity). No state is named for the anchor list, so ND's single-source status
  carries no weight here.
- "Thirty in one state, forty in another, fifty in a third" = states[CO].cmeHours 30,
  states[ME].cmeHours 40 (MD), states[CA].cmeHours 50. All three multi-source verified.
- Maine DO vs MD = states[ME].pitfalls[3] and states[ME].cmeDetails ("MD: 40 hours per
  2-year cycle ... DO: 100 hours per 2-year cycle"). Rule cite: states[ME].cmeSource,
  "ME BLM Rules ch. 1 s. 11 (amended eff. Feb 3, 2026)".
- California 26-month first cycle = states[CA].renewalAnchor, "Initial MD licenses issued on
  or after January 1, 2024 get a 26-month first cycle, then revert to 24 months." Stated as
  MD-specific in the essay, matching the field.
- Colorado short first period = states[CO].pitfalls[0].
- Maine short first license = states[ME].pitfalls[0], "A first license is typically shorter
  than 2 years for the same reason."
- IMLC = phrased as "did not put them on one clock", which is what the data supports:
  states[AL].pitfalls[1] notes compact licenses renew on the IMLC site rather than the state
  portal, i.e. a separate path, not a merged one. The stronger claim in
  marketing/pain-points-analysis.md ("does not synchronize renewals") is an agent-written
  analysis with no primary source and is deliberately not used verbatim.
- Texas one-year cancellation = states[TX].graceOrLapse, quoting board text: "If a license
  has been expired for one year or longer it is automatically cancelled." Also
  states[TX].pitfalls[4].
  ** VERIFY BEFORE SUBMITTING. ** states[TX].verified == "2026-08 (single-source)". This is
  the only single-source claim in the essay. It is a direct quote of TMB's own language, so
  the risk is low, but a real submission to a real editor should not rest on a single-source
  entry. Confirm on the TMB renewal page, or cut the Texas sentence; California and Maine
  alone carry the paragraph.
- California no grace period, delinquent day after = states[CA].graceOrLapse, "No grace
  period (MBC states this explicitly). It is illegal to practice medicine with an expired
  license; status shows 'Delinquent' on the board lookup the day after expiration."
- Maine 90 days, then 12 months of practice or competency exam = states[ME].graceOrLapse and
  states[ME].pitfalls[1].

PERSONAL CLAIMS, all consistent with what is already on file in the repo:
- Neurosurgeon, DO, works locums, holds licenses in several states, tracked them in a
  spreadsheet: marketing/emails/waitlist-sequence.md Email 1, Eric's own approved copy.
- No date, duration, dollar figure, patient detail or colleague story appears anywhere in the
  essay. Nothing here needs Eric to remember a number.
- The hotel desk and the forty minutes are the only scene details. Eric should confirm they
  are true of him or swap in his own; the Colorado portal fact holds either way.

NO PRODUCT PITCH: the body never names the product, never describes a feature, never links.
The only mention is the byline, which is the standard KevinMD founder disclosure.
-->

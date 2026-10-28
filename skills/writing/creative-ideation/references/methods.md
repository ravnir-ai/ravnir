# Methods

One entry per method. Use one at a time. Attribution is part of the method: say who devised it.

## Constraints (blank page)

A constraint plus a direction gives traction. Pick one that matches the owner's wording or mood,
generate three ideas that satisfy it, and offer the best. Do not list them all.

- **Start at the punchline.** Think of a funny sentence, then work backwards to make it real.
- **High concept, low effort.** A deep idea, executed in an afternoon.
- **Translate.** Take something made for one audience and make it understandable by another: a paper
  as a children's book, an API as a board game.
- **Make a mirror.** Something that reflects the viewer back at themselves.
- **The useless tree.** Make something deliberately, completely useless.
- **One million of something.** Pick an object and imagine a million of them.
- **Make something that dies.** A site that loses a feature each day, a chatbot that forgets.
- **Solve your own itch.** The tool you wished existed this week, under 50 lines.
- **Automate the annoying thing.** The most tedious part of a workflow, scripted away.
- **Nothing new except glue.** Build only from existing APIs, libraries and datasets.
- **Subtract.** Remove from a thing until only the essence remains.

## SCAMPER (has a base idea, wants variations)

Devised by Bob Eberle, building on Alex Osborn's checklist. State the base in one sentence, then run
all seven operators without skipping any. The cells you least want to run often hold the surprise.

- **Substitute** a component, material, person, place or process.
- **Combine** two things: functions, parts, audiences, formats.
- **Adapt** an idea from another field.
- **Modify, magnify or minify**: change scale, frequency, intensity, shape.
- **Put to other uses**: the same thing for a different purpose.
- **Eliminate** a component. Often the highest-leverage cell.
- **Reverse or rearrange**: invert relationships or change the sequence.

Most output will be weak. Take the one or two interesting cells, elaborate them, discard the rest.
Show the owner one to three, not seven. "Combine with AI" and "make it a subscription" are slop.

## Volume generation (many ideas fast)

Three traditions: Crazy 8s (Google Ventures sprint), brainwriting 6-3-5 (Bernd Rohrbach), and James
Webb Young's five stages for producing ideas.

- **Crazy 8s, solo.** Write eight different ideas, one line each, with a different generative lens
  for each (reverse it, shrink it, remove a part, give it to another audience). The last few are
  usually better than the first few. If only five produce anything, report five.
- **Brainwriting**, for a group: each person writes three ideas, passes the sheet, and the next
  person builds on or replaces them. It avoids the dominance and apprehension of speaking aloud. With
  agents, `message_bot` can collect independent first drafts before anyone sees the others.
- **Young's stages.** Gather material (specific and general), digest it, step away, let the idea
  arrive, then shape it. The step away cannot be skipped; offer to come back to it later with
  `create_job` if the owner has time.

Eight variations of one idea is one idea. Force divergence. Surface one to three to the owner.

## Premortem and inversion (choosing and pressure-testing)

Premortem comes from Gary Klein. Imagine the plan has already failed badly and work backwards.
Inversion comes from Charlie Munger via Jacobi: work out how to guarantee failure, then avoid it.

- **Premortem.** State the plan as complete and failed on a specific future date. Write concrete
  failure stories, not generic risks ("the vendor changed pricing and we had no export"), cluster
  them, rank by likelihood and severity, and propose mitigations for the top three.
- **Inversion.** Restate the goal, then ask how you would guarantee the opposite. List specific
  actions that would do that, and check which ones the owner is already doing or drifting into.

Use them on candidate ideas, not on fragile early ones. They are tests, not vetoes. If there are no
real concerns, say the premortem is short.

## Oblique strategies (stuck mid-project)

Devised by Brian Eno and Peter Schmidt as cards for studio deadlocks. Pick a prompt at random (not
the one that feels apt), apply it literally to the next decision, and make the move it suggests.
Examples: "Use an old idea." "Only one element of each kind." "Work at a different speed." "Look
closely at the most embarrassing details and amplify." "Honour thy error as a hidden intention."
Requires existing material. Keep the explanation to the card, what it means here, and the move.

## Lateral provocations (too safe)

Devised by Edward de Bono. "Po" marks a statement as a provocation, not a claim. Write one with an
operator, list five consequences if it were true, pick the strongest, and turn it into a real
proposal.

- **Escape**: negate something normally true. "Po: the meeting has no agenda."
- **Reversal**: reverse a relationship. "Po: the readers write the book."
- **Exaggeration**: push a parameter to an extreme. "Po: the company has one customer."
- **Distortion**: change order or place. "Po: revenue arrives before expenses."
- **Wishful thinking**: state an impossible outcome. "Po: the software ships without bugs."

Random word technique: choose a genuinely random noun (do not pick one yourself), list five
connections to the problem, however tenuous, and use the strongest. The provocation is the means; a
usable proposal is the end.

## Affinity diagram (pile of notes or feedback)

The KJ method, by Jiro Kawakita. Needs about fifteen or more items. Write one observation per item,
cluster by similarity without imposing categories in advance, and name each cluster specifically
("requests for offline use", not "technical issues"). Look at orphans (often the most interesting)
and at gaps (what nobody mentioned). Finish with a one or two paragraph narrative using the cluster
names; if it does not hold together, the clusters are wrong. Models tend to impose familiar
categories, so ask what the most surprising cluster is, and never invent items to fill a cluster.

## Jobs to be done (product, service, business)

Developed by Clayton Christensen and others. People hire products to do a job in a situation. State it
as: "When [situation], I want to [motivation], so I can [outcome]." Generic jobs are platitudes.

Bob Moesta's four forces: a person switches when push (pain now) plus pull (appeal of the new) is
greater than anxiety (about the new) plus habit (the old way). Most failed launches lose on anxiety
and habit, so design for those too. The honest way to find a job is to interview someone who
recently switched; without customers, say so and recommend running interviews rather than making up
data. Do not apply it to art, research or civic work.

## First principles (suspect the usual way is outdated)

List the assumptions in the standard solution, five to ten, including the unspoken ones. Label each
physical, informational, conventional, historical or taught as a simplification. Question the
conventional and historical ones, rebuild from the rest for this owner's actual context, then apply
Chesterton's fence: find out why each removed thing was added before concluding it was pointless.
Count the cost of switching. Do not use it in a domain you do not understand, and do not perform it:
the result should look measurably different from the conventional answer.

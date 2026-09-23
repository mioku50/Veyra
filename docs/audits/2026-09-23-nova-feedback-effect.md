# Nova — what the owner's feedback did to their brief

Roadmap item 5 closed on 22 September with one thing it could not show:
"that any of this moved an actual brief". This note shows it on the owner's
own agent, and changes what it found. Every figure comes from read-only
queries against production. Only the owner's agent was read, and nothing was
written.

## How it was measured

- A signal's relevance band is scored once, when the signal is observed. The
  inputs are its kind, the owner's interest words and the preferences Nova
  had learned by then, and the reasons are stored with the band. The score
  was rebuilt from those reasons for all 169 of the owner's signals. The
  rebuilt band matched the stored one in all 169.
- The scores were then rebuilt without the learned preferences, and the brief
  was assembled both ways from the same sixty rows the page loads.
- Separately, every stored announcement was scored again from its stored
  article, using the owner's current interests and preferences, once by the
  scorer in production and once by the changed one.

## What the owner had taught

| Preference | Learned from |
| --- | --- |
| cares about "announcements" | "Useful" on announcements, among them readings of Sponsored Transactions on Arc, the Arc Compatibility Guide and Circle's notice discontinuing CCTP V1 on Noble |
| cares about "price changes" | "Useful" on a price change, 21 September |
| usually ignores "cirbtc" | "Not interesting" on "cirBTC Is Now Live on Arc", 22 September |

## What it did

A preference applies only to signals observed after it was learned. Since
then, three signals have been scored with one, all of them announcements
observed on 22 and 23 September.

- **"announcements" added 10 to each.** Two of them crossed the "high
  relevance" line at 70:
  - StableFX went from 66 to 76. The owner had objected to StableFX.
  - A LangChain post, "The Reliability Layer for Healthcare AI", also went
    from 66 to 76.

  Each had three watched words somewhere in its text.
- **The band decides what is read first.** In the owner's own refresh at
  15:44 UTC on 23 September, those two were the first two of three readings.
  The LangChain post was found not significant. Without the boost, its
  reading would have gone to a card on the owner's Today. Those cards were
  still waiting to be re-read under the current rules.
- **"cirbtc" subtracted 18 once.** It hit "Introducing Interop on Arc", whose
  article mentions cirBTC. No card about cirBTC has arrived since.
- **"price changes" applied to nothing.**
- **Today did not change.** It showed the same four cards in the same order
  with or without anything learned. The only visible difference was StableFX
  marked "high relevance" instead of "worth reading".

So feedback does change prioritization, and every change observed went
against what the owner had said.

With the preferences as they stand, the scorer in production would mark 21 of
the owner's 28 stored announcements "high relevance" if they arrived today,
10 of them LangChain posts. It would also demote three Arc announcements for
mentioning cirBTC: Interop, "Arc Mainnet Is Live" and the Arc Portal.

## Why

- **A category boost cannot tell announcements apart.** Without it, an
  announcement scores between 48 and 66 and is always "worth reading". With
  it, any article whose text holds two watched words crosses into "high
  relevance". The words are the owner's interest words, and LangChain's posts
  about agents and models match them as well as Arc's do.
- **A publication's subject text is the whole article.** Interest words are
  matched there on purpose. Preferences were matched there too, so a product
  dismissed from one headline demoted every article that mentioned it.
- **A category phrase could match through prose.** "Price changes" in a
  listing's description counted as a price change.

## What changed

- **"Useful" on a publication is a rating, not a boost.** On an announcement
  or a release, the press is kept as a rating of the reading, for item 1's
  review, as before. It no longer raises the whole category.
- **Stored "announcements" and "releases" preferences stop applying.** What
  Nova knows about the owner lists them under "No longer used", with a way to
  forget them.
- **The press says what it did.** It used to answer "Nova will rank
  announcements higher." It now says "Kept as your rating of this reading. It
  does not rank all announcements higher; each one is placed by its own
  reading against your goal."
- **A preference matches what a card is about.** For a publication, that is
  its feed and its headline, not its text.
- **A category preference matches its category and nothing else.**

Unchanged:
- "Useful" on commits, new capabilities and price changes still raises them.
- "Not interesting" on an announcement still learns a product name from its
  headline.
- "Ignore announcements" still works.
- Following a feed adds 28. After this change it is the lever for a
  publisher, and the only way an announcement reaches "high relevance".

Scored again the same way, the owner's 28 announcements change as follows:

| | Scorer in production | Changed scorer |
| --- | --- | --- |
| Marked "high relevance" | 21 | 0 |
| The cirBTC card itself | 58, demoted | 48, still demoted |
| Interop, "Arc Mainnet Is Live" and the Arc Portal | 58, demoted for mentioning cirBTC | 66, not demoted |

## Not done

- **Stored bands are not rewritten.** StableFX keeps "high relevance", and
  the LangChain post keeps its place ahead of every "worth reading" card the
  next time the rules change. Correcting those two rows would be a write to
  production and was not made.
- **Interest words are matched against the whole article.** So posts about
  agents and models from LangChain score like Arc's. That belongs to source
  coverage, not to feedback.
- **No positive lever finer than a feed.** A product name from the headline
  was the obvious candidate. None of the owner's announcement headlines
  marked useful contains one, so it would have learned nothing.
- **No new ratings.** The owner has rated nothing since a rating could carry
  a reason. The last rating was at 19:09 UTC on 22 September.

## Verified

- The bands rebuilt from stored reasons matched the stored bands for 169 of
  169 signals.
- On the three real cases, the scorer in production reproduces the stored
  scores and reasons exactly: 76, 76 and 58. The changed scorer gives 66, 66
  and 66.
- `nova-feedback:test` now covers:
  - the owner's three cases;
  - a category matched only as a category;
  - following still lifting one feed and not another;
  - what each press says.

  `nova:test` passes unchanged, and so does the full release gate.

## Not verified

- The "No longer used" row on the owner's screen.
- Whether the owner wants "announcements" forgotten. That is theirs to
  decide.

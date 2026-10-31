# Extra

Extra holds the pages that are not targets. They come in this order: **AI**, **Prompts**, **Media**, **Feedback** and **Research links**, then, under "Customize", **Campaigns**, **Tags** and **Categories**. Statuses are edited in Settings > Statuses.

Every page starts with the same header: its name, how many entries it has, a filter box and an **Add** button. On pages with a form, Add takes you to the form's first box. A page with nothing on it says what it is for.

## What is shared and what belongs to one startup

| Shared by all your startups | Kept per startup |
|---|---|
| The AI page, prompts, campaigns, tags, categories, fields, and the option lists of Media, Feedback and Research links | Media, feedback and research links (unless a link is ticked "Shared") |

Shared data is saved a moment after you change it. If another tab or startup changed the same entry first, the page reloads the shared data and shows that version, so nothing is overwritten silently.

## AI

Keep the AI subscriptions and API accounts you pay for, the models you prefer, and links to their dashboards. **Add subscription or API** creates an entry and opens it; change its type in the form. The page starts empty.

The monthly total adds up the subscriptions that are not struck through. A cost that mentions RON or lei counts as lei; any other number counts as dollars and is converted at the rate shown above the list. Change the rate there when it moves; the page shows when you last changed it. The starting rate is 4.55.

"Current flow" is the order in which you use your tools, as before.

## Media

Screenshots, videos, documents and logos, uploaded or linked. **Used in** links a file to any other record: targets, programs, funding, feedback, campaigns or research links. Filter by type, source, what it is linked to, tag, or one record it is used in. Images show as thumbnails.

**Copy to another startup** (the copy icon on a card) copies the file and its details. Its "Used in" links stay in this startup, because they point at this startup's records.

Deleting moves a media item to the recycle bin. Its file stays on disk until the item is deleted for good, and even then a file that something else still names is kept. `node tools/media-orphans.js` lists files that no record names; it never deletes anything.

**Options** edits the media types. They are shared by all your startups.

## Feedback

What users say and do. Each entry has a type, a source, a stage, a product area, how strong the evidence is and how well you know the person. Feedback can be about any target, and the cards show what it is about.

Some types open a block of extra fields:

| Block | Fields | Shipped with |
|---|---|---|
| Person and context | Role, company or team, what they use today, what they want to get done, next contact date | User feedback, user interview, person to keep in touch with, testimonial, case study, feature request |
| Journey | Furthest step reached (discovered, signed up, activated, repeat use, churned), times used, why they stopped | Objection, onboarding friction, activation, retention or churn, usage outcome |
| Assumption test | The assumption, evidence for, evidence against, verdict, next review date | Assumption test |

A block that already holds something stays visible if you change the type.

**Options** edits every feedback list, including which block each type opens. The lists are shared by all your startups. Removing an option does not change the entries that use it: they keep the value and show it as written.

## Research links

Pages you check regularly, in groups such as LinkedIn, Reddit or Newsletters, each group with its icon. One entry can hold several addresses separated by `;`. **Open all** opens every active link of a group.

Tick **Shared with all startups** to show a link in every startup; untick it to keep it in the current one only. **Groups** edits the groups and their icons, shared by all your startups.

## Campaigns

A campaign groups targets around one goal, such as a launch. Campaigns are shared, so a campaign can hold targets from every startup. Its card lists this startup's targets, programs and funding, and under "In other startups" the targets of your other startups, each marked with its startup; selecting one opens it there. Campaign statuses come from Settings > Statuses. Deleting moves a campaign to the recycle bin.

## Tags

Tags are short labels on targets, media, feedback and campaigns, shared by all your startups. Each can have a description and a colour. A new install starts with a small set (quick-win, warm-contact, follow-up, high-impact, evergreen, needs-review, partner, local, online, paid, free); a default you delete does not come back.

Editing a tag shows which startups use it and lets you:

- **Rename** it. Every record with the tag, in every startup, gets the new name. Renaming onto a tag that exists merges the two.
- **Merge** it into another tag.
- **Delete** it. The tag is taken off every record and goes to the recycle bin.

Merging and deleting take a safety backup first (Settings > Backups). Save any open edits before you rename, merge or delete; the page asks you to if something is still saving.

## Categories

**Categories** is the category library (see [Categories](categories.md)).

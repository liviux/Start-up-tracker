# The target window and fields

Every target in Marketing, Programs and Funding opens in the same window, with the same six tabs:

| Tab | What it holds |
|---|---|
| Overview | Status, category, priority and dates at a glance, the target's link, the notes as you wrote them, and "All details": every filled field by group, the activity, the links and when the target last changed. |
| Edit | Status and priority at the top, then the notes in Markdown with a live preview. |
| Details | The basics first, then the section's fields in groups, then the activity: key dates and milestones, the update log, documents (Programs), commitments and payments (Funding). |
| Links | Every link to other records (see [Links](links.md)), and buttons to create a linked target in Marketing, Programs or Funding. |
| Extras | Your own fields (Extra > Fields), and "Other fields": values the target holds that no field describes. |
| History | Every change to the target, with "Restore this value" on each field. |

![The target window's Overview tab, with All details open on the filled fields](assets/screenshot-target.png)

*The target window: status and dates, and every filled field by group under "All details".*

Changes stay in the window until you press **Save**. **Cancel**, **Esc** or the close button ask before dropping them. **Enter** in a one-line box saves. **Move to recycle bin** deletes the target; you can restore it from Settings > Recycle bin.

## Fields

Every field has a short help text under it and, where it helps, an example inside the box. Examples are grey, slanted and start with "e.g.": they are never saved. Some fields offer a suggested value, such as your startup's currency; it is saved only when you press **Use**.

In number fields an empty box means "not known" and 0 is a real zero, so the two never mix in totals.

The basics are the same in every section: ID (with a copy button), name, categories, status, next action date and time, organization, link, priority, next action, deadline, owner, campaign, tags and repeat. Programs also have the kind (opportunity or watchlist) and Funding the funding round.

The section fields are listed in `content/fields/` (`common.json`, `mk.json`, `po.json`, `fu.json`), each with its help text, example and choices. About 30 for Marketing (audience, rules, results, effort, contact, timing, learning), 42 for Programs (provider, eligibility, value and costs, application) and 31 for Funding (funder, contact, ask and terms, process).

## The update log

**Log update** in Details records what happened, the outcome, the next action and the status after. Saving the entry also moves the target on: its status becomes the status after, and its next action and date follow the entry when you give them.

## Your own fields

**Extra > Fields** adds fields of your own to Marketing, Programs or Funding targets: a label, a type (text, number, amount and currency, date, link, a choice from a list and so on), a help text, an example and a group. They are shared by all your startups and show in the Extras tab of every target in that section.

Deleting a field does not delete what targets hold in it: the values move to "Other fields", and adding the field back with the same key brings them back.

The same page edits the **Programs documents checklist**, the documents a program can ask for, shared by all your startups. A program keeps a document you remove from the checklist, with its status and notes.

## Older data

Targets made before this window keep everything they had. Where an older field has exactly one new home, its value moves there the first time the startup opens, and only into an empty field: for example a program's call reference becomes **Reference ID**, its preparation hours become **Effort**, a target's audience extra parameter becomes **Audience**. Fields that would need a judgement to merge, such as a minimum and maximum cash amount, the support flags or the old document checkboxes, stay as they were and show under "Other fields", where you can still edit them.

Some keys keep their stored names so the rest of the app reads them as before: a Marketing target's name is stored as `platform` and its next action date as `date`; a Funding target's name is `opportunity` and its organization `funder`. The window shows the common names.

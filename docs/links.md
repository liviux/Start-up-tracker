# Links

Any two records of a startup can be linked: a target and the program it led to, a video and the posts that use it, a piece of feedback and the target it is about. A link shows on both records, each with its own name for it.

| Relation | On the first record | On the second |
|---|---|---|
| Related | Related | Related |
| Uses | Uses | Used in |
| Feedback about | Feedback about | Feedback |
| Blocks | Blocks | Blocked by |
| Follow-up of | Follow-up of | Followed up by |
| Funds | Funds | Funded by |

## Adding and removing links

Every target window has a **Links** tab (see [The target window and fields](fields.md)). Pick a relation, then type in the box next to it: matching targets, programs, funding, media, feedback, campaigns and research links show up grouped by kind, with the section colour, the status and a second line. Arrow keys move through the list, Enter picks, Escape closes it. Recent picks come first. Long lists come 20 at a time with "Show more".

A link is saved as soon as you add it, and **×** removes it. Clicking a linked record opens it.

Other places pick records the same way:

- **Media**: "Used in" on the add form and on the card being edited. The filter above the list shows all media, media used nowhere, or media used in one record. What a use was for and where it led are kept on the link.
- **Feedback**: "About" on the add form and on the card being edited.

Targets, programs and funding show their links as pills in their lists.

## The startup's own links

Links between records are different from the startup's own links: its website, profiles and pages, kept in **Settings > Startup profile** or added in the [setup](setup.md). Those show in the **Links** menu at the top of every page, each with an icon for where it points (GitHub, LinkedIn, Product Hunt and about 30 more), and fill `{{STARTUP_LINKS}}` in prompts. Pasting an address picks its type. Only `http`, `https`, `mailto` and `tel` addresses become clickable.

## Deleted records

A link to a record in the recycle bin is hidden, not removed. Restore the record and the link is back. When a record is deleted for good, by "Delete forever", by emptying the bin or after the retention period, its links go with it.

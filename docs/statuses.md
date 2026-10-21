# Statuses

Every target has one status. Marketing, Programs, Funding and Company use the same list, and every startup in the tracker shares it, so a filter or a count means the same thing everywhere.

## Groups

Each status belongs to one of four groups. The groups are fixed.

| Group | Built-in statuses | Meaning |
|---|---|---|
| Planned | New, Researching, Scheduled, Later | Not started yet. |
| In progress | Preparing, In contact, Submitted, Interview / pitch, Due diligence, Negotiating, Won, Active, Blocked, On hold | Work still to do, including work that is paused or accepted but not finished. |
| Done | Published, Received, Completed | Finished. |
| Closed | Rejected, Not pursuing, Not eligible, Expired, No response | Ended without a result. |

Submitted, Interview / pitch and Due diligence are the statuses that wait for the other side's answer. The Programs header counts them as "Waiting for an answer".

Won and Active stay in progress because accepted work usually still needs something: onboarding, a contract, a payment that has not arrived. Blocked and On hold stay in progress so paused work does not drop out of view.

New targets start as **New**.

## Badges and filters

A status badge takes its colour from its group. Dropdowns list the statuses under their group.

The status filter above every focus queue, Targets list and the calendar has one chip per group. A chip shows **All**, **Off** or how many of the group's statuses are selected (for example `3/10`), with the number of records. Click the group name to turn the whole group on or off, or open it with the arrow to pick single statuses. The arrow also opens with Enter or Space. **Select all / none** at the bottom flips everything.

By default the filter shows Planned and In progress.

## Unmapped statuses

A record can carry a status the list does not know, for example after an import from another tracker. The tracker keeps that value as it is and never replaces it. It shows with a dashed badge, counts as open, and the filter gets an extra **Unmapped** group while such records exist. Pick a status from the list to map the record.

An import lists the unknown statuses it found before you apply it.

## Editing the list

**Settings > Statuses** changes the list for every startup at once.

- Rename any status and give it a description. The description shows as a tooltip on badges and in the filter.
- Move statuses up and down within their group. The order is the order in dropdowns and filters.
- Add your own status to any group.
- Delete one of your own statuses. You choose where its records go first; they move in every startup and in the recycle bins, and record history notes the move.

Built-in statuses cannot be deleted and cannot change group, so their ids stay stable for imports and tools.

## Campaign statuses

Campaigns have their own, shorter list: Planned, Active, Paused, Done and Archived. It has no groups. You can rename, describe, reorder, add and delete them; deleting one moves its campaigns to the status you pick. At least one stays.

## Priorities

Very high, High, Medium, Low and Very low. The list is fixed and shown in Settings > Statuses for reference.

## Other status lists

Payments, commitments, program documents and feedback keep their own small lists, because they track something else: money arriving, paperwork, or what happened with a piece of feedback.

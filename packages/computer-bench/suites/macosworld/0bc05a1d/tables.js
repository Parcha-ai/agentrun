// osascript -l JavaScript -e <this file> <t0>
// The notes made since t0 (seconds since 1970, written by setup) that are not in Recently Deleted, as one line:
// "notes=N tables=T filled=F": how many such notes, how many tables their bodies hold, and how many of those tables'
// cells hold any text.
function run(argv) {
	const since = Number(argv[0]) * 1000;
	const Notes = Application('Notes');
	const ids = Notes.notes.id();
	const made = Notes.notes.creationDate();
	let notes = 0;
	let tables = 0;
	let filled = 0;
	for (let i = 0; i < ids.length; i++) {
		if (!(since > 0) || made[i].getTime() <= since) continue;
		const note = Notes.notes.byId(ids[i]);
		if (note.container().name() === 'Recently Deleted') continue;
		notes++;
		for (const table of note.body().match(/<table[\s\S]*?<\/table>/g) || []) {
			tables++;
			for (const cell of table.match(/<td[\s\S]*?<\/td>/g) || []) {
				if (cell.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim() !== '') filled++;
			}
		}
	}
	return 'notes=' + notes + ' tables=' + tables + ' filled=' + filled;
}

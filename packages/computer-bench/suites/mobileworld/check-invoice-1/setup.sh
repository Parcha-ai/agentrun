# Put the invoice at /sdcard/Download/invoice.pdf. $1 is invoice.pdf from the task's folder: the PDF up to its last
# object. The cross-reference table is added here, because its lines end in a space that a repo text file doesn't keep;
# startxref is the byte count written so far. A file already at that path is moved aside once (a retried setup keeps
# the first copy) and teardown puts it back.
D=/sdcard/Download
S=/sdcard/.computer-bench-{{nonce}}
F=$D/invoice.pdf
mkdir -p $D $S || exit 1
if [ ! -e $S/stashed ]; then
	if [ -e $F ]; then mv $F $S/invoice.pdf || exit 1; fi
	touch $S/stashed
fi
printf '%s' "$1" > $F || exit 1
x=$(wc -c < $F)
printf 'xref\n0 6\n0000000000 65535 f \n0000000009 00000 n \n0000000058 00000 n \n0000000115 00000 n \n0000000241 00000 n \n0000000309 00000 n \ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n%s\n%%%%EOF\n' $x >> $F || exit 1
[ "$(head -c 8 $F)" = "%PDF-1.4" ] && [ "$(tail -c 6 $F)" = "%%EOF" ] || exit 1
am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d "file://$F" > /dev/null 2>&1
true

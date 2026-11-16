# Delete the run's files and the Finance/invoice folder, then put back what setup moved aside. Nothing is deleted unless
# setup finished moving the phone's own files aside. /sdcard/Finance goes too when setup made it.
D=/sdcard/Download
S=/sdcard/.computer-bench-{{nonce}}
NAMES="invoice_2025_001.pdf invoice_payment.pdf receipt_2025_002.pdf report_2025.pdf document.txt presentation.pdf notes.doc data.csv summary.pdf"
if [ -e $S/stashed ]; then
	for f in $NAMES; do rm -f "$D/$f"; done
	rm -rf /sdcard/Finance/invoice
	if [ -e $S/finance-invoice ]; then mv $S/finance-invoice /sdcard/Finance/invoice; fi
	if [ ! -e $S/had-finance ]; then rmdir /sdcard/Finance 2>/dev/null; fi
fi
for f in $S/stash/*; do if [ -e "$f" ]; then mv "$f" $D/; fi; done
for f in $NAMES; do am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d "file://$D/$f" > /dev/null 2>&1; done
rm -rf $S
true

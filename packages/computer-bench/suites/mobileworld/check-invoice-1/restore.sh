# Delete the run's invoice and put back a file setup moved aside. Nothing is deleted unless setup finished that step.
D=/sdcard/Download
S=/sdcard/.computer-bench-{{nonce}}
F=$D/invoice.pdf
if [ -e $S/stashed ]; then
	rm -f $F
	if [ -e $S/invoice.pdf ]; then mv $S/invoice.pdf $F; fi
	am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d "file://$F" > /dev/null 2>&1
fi
rm -rf $S
input keyevent KEYCODE_HOME
true

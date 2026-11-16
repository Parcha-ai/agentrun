# Seed /sdcard/Download with three invoice or receipt files (November, October and December 2025) and six others, and
# make /sdcard/Finance with no invoice folder in it. What was in the way (files of these names, any other file in Download
# that names an invoice or a receipt, a Finance/invoice folder) is moved aside once, into a hidden folder on the same
# storage (a retried setup keeps the first copy), and teardown puts it back.
D=/sdcard/Download
S=/sdcard/.computer-bench-{{nonce}}
NAMES="invoice_2025_001.pdf invoice_payment.pdf receipt_2025_002.pdf report_2025.pdf document.txt presentation.pdf notes.doc data.csv summary.pdf"
mkdir -p $D $S/stash || exit 1
if [ ! -e $S/stashed ]; then
	find $D -maxdepth 1 -type f \( -iname '*invoice*' -o -iname '*receipt*' \) > $S/aside.list
	for f in $NAMES; do echo "$D/$f" >> $S/aside.list; done
	while read -r f; do if [ -e "$f" ]; then mv "$f" $S/stash/ || exit 1; fi; done < $S/aside.list
	if [ -d /sdcard/Finance ]; then touch $S/had-finance; fi
	if [ -e /sdcard/Finance/invoice ]; then mv /sdcard/Finance/invoice $S/finance-invoice || exit 1; fi
	touch $S/stashed
fi
rm -rf /sdcard/Finance/invoice
mkdir -p /sdcard/Finance || exit 1
cat > $D/invoice_2025_001.pdf <<'EOF'
%PDF-1.4
INVOICE/RECEIPT
==================================================

Item: Office Supplies
Date: 2025-01-15
Amount: $125.50
Description: Printer paper, pens, notebooks
Reimbursable: Yes
--------------------------------------------------
Item: Software License
Date: 2025-01-20
Amount: $299.99
Description: Annual subscription for design software
Reimbursable: Yes
--------------------------------------------------

Total Amount: $425.49
==================================================
EOF
touch -t 202511151200 $D/invoice_2025_001.pdf || exit 1
cat > $D/invoice_payment.pdf <<'EOF'
%PDF-1.4
INVOICE/RECEIPT
==================================================

Item: Travel Expense
Date: 2025-01-25
Amount: $450.00
Description: Flight ticket for business trip
Reimbursable: Yes
--------------------------------------------------

Total Amount: $450.00
==================================================
EOF
touch -t 202510201200 $D/invoice_payment.pdf || exit 1
cat > $D/receipt_2025_002.pdf <<'EOF'
%PDF-1.4
INVOICE/RECEIPT
==================================================

Item: Meal Expense
Date: 2025-02-01
Amount: $85.30
Description: Business lunch with client
Reimbursable: Yes
--------------------------------------------------
Item: Hotel Accommodation
Date: 2025-02-20
Amount: $280.00
Description: Hotel stay for conference
Reimbursable: Yes
--------------------------------------------------
Item: Taxi Fare
Date: 2025-02-22
Amount: $45.50
Description: Taxi to airport
Reimbursable: Yes
--------------------------------------------------

Total Amount: $410.80
==================================================
EOF
touch -t 202512051200 $D/receipt_2025_002.pdf || exit 1
echo 'This is a pdf file, not an invoice or receipt.' > $D/report_2025.pdf
echo 'This is a txt file, not an invoice or receipt.' > $D/document.txt
echo 'This is a pdf file, not an invoice or receipt.' > $D/presentation.pdf
echo 'This is a doc file, not an invoice or receipt.' > $D/notes.doc
echo 'This is a csv file, not an invoice or receipt.' > $D/data.csv
echo 'This is a pdf file, not an invoice or receipt.' > $D/summary.pdf
# Ask the media scanner to read each file again, so file managers that list Download through MediaStore show these dates.
for f in $NAMES; do am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d "file://$D/$f" > /dev/null 2>&1; done
true

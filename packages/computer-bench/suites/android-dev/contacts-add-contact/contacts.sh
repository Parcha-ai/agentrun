# This task's contacts helper, run on the phone as: sh -c "<this file>" sh VERB ARG...
# It reaches ContactsProvider through `content`; the shell user holds READ_CONTACTS and WRITE_CONTACTS.
u=content://com.android.contacts
rawid() { content query --uri $u/raw_contacts --projection _id --where "$1" | sed -n 's/.*_id=\([0-9][0-9]*\).*/\1/p' | tail -n 1; }
case "$1" in
open)
	# Grant the contacts apps their permissions (a no-op when granted or not installed), then open the one installed.
	# Without POST_NOTIFICATIONS, AOSP Contacts opens on Android 13+ behind a notifications prompt.
	for p in com.google.android.contacts com.android.contacts com.samsung.android.app.contacts; do
		pm grant $p android.permission.READ_CONTACTS 2>/dev/null
		pm grant $p android.permission.WRITE_CONTACTS 2>/dev/null
		pm grant $p android.permission.POST_NOTIFICATIONS 2>/dev/null
	done
	am start -W --activity-clear-task -a android.intent.action.MAIN -c android.intent.category.APP_CONTACTS ;;
add)
	# add TAG NAME PHONE: a contact on the phone (no account), its raw contact's sourceid TAG.
	content insert --uri $u/raw_contacts --bind account_name:n: --bind account_type:n: --bind "sourceid:s:$2" || exit 1
	id=$(rawid "sourceid='$2' AND deleted=0")
	[ -n "$id" ] || exit 1
	content insert --uri $u/data --bind raw_contact_id:i:$id --bind mimetype:s:vnd.android.cursor.item/name --bind "data1:s:$3" || exit 1
	content insert --uri $u/data --bind raw_contact_id:i:$id --bind mimetype:s:vnd.android.cursor.item/phone_v2 --bind "data1:s:$4" --bind data2:i:2 ;;
count)
	# count NAME: how many contacts show with exactly this display name.
	content query --uri $u/contacts --projection _id --where "display_name='$2'" | grep -c '^Row'
	true ;;
phones)
	# phones NAME: the phone numbers of the contacts with this display name, one "data1=" row each.
	content query --uri $u/data --projection data1 --where "mimetype='vnd.android.cursor.item/phone_v2' AND display_name='$2'" ;;
emails)
	# emails NAME: the email addresses of the contacts with this display name.
	content query --uri $u/data --projection data1 --where "mimetype='vnd.android.cursor.item/email_v2' AND display_name='$2'" ;;
purge)
	# purge NONCE: every contact whose name holds the run's nonce. Phone-only contacts go at once; one the agent saved
	# to an account is marked deleted, and its sync adapter removes it from the account. An empty NONCE would match
	# every contact, so it is refused.
	[ ${#2} -ge 6 ] || exit 2
	content delete --uri $u/raw_contacts --where "display_name LIKE '%$2%'" ;;
*)
	echo "contacts.sh: no verb $1" >&2
	exit 2 ;;
esac

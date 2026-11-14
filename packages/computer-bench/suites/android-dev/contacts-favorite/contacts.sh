# This task's contacts helper, run on the phone as: sh -c "<this file>" sh VERB ARG...
# It reaches ContactsProvider through `content`; the shell user holds READ_CONTACTS and WRITE_CONTACTS.
u=content://com.android.contacts
rawid() { content query --uri $u/raw_contacts --projection _id --where "$1" | sed -n 's/.*_id=\([0-9][0-9]*\).*/\1/p' | tail -n 1; }
case "$1" in
open)
	# Grant the contacts apps their permissions, notifications too so no permission dialog covers the list (a no-op
	# when granted or not installed), then open the one installed.
	for p in com.google.android.contacts com.android.contacts com.samsung.android.app.contacts; do
		for perm in READ_CONTACTS WRITE_CONTACTS POST_NOTIFICATIONS; do pm grant $p android.permission.$perm 2> /dev/null; done
	done
	am start -W --activity-clear-task -a android.intent.action.MAIN -c android.intent.category.APP_CONTACTS ;;
add)
	# add TAG NAME PHONE [TYPE]: a contact on the phone (no account), its raw contact's sourceid TAG, its phone of TYPE
	# (ContactsContract's Phone.TYPE: 1 home, 2 mobile, 3 work; default 2).
	content insert --uri $u/raw_contacts --bind account_name:n: --bind account_type:n: --bind "sourceid:s:$2" || exit 1
	id=$(rawid "sourceid='$2' AND deleted=0")
	[ -n "$id" ] || exit 1
	content insert --uri $u/data --bind raw_contact_id:i:$id --bind mimetype:s:vnd.android.cursor.item/name --bind "data1:s:$3" || exit 1
	content insert --uri $u/data --bind raw_contact_id:i:$id --bind mimetype:s:vnd.android.cursor.item/phone_v2 --bind "data1:s:$4" --bind "data2:i:${5:-2}" ;;
add-phone)
	# add-phone NAME NUMBER TYPE: another phone number on the contact.
	id=$(rawid "display_name='$2' AND deleted=0")
	[ -n "$id" ] || exit 1
	content insert --uri $u/data --bind raw_contact_id:i:$id --bind mimetype:s:vnd.android.cursor.item/phone_v2 --bind "data1:s:$3" --bind "data2:i:$4" ;;
star)
	# star NAME: the contact is a favourite.
	content update --uri $u/contacts --bind starred:i:1 --where "display_name='$2'" ;;
list)
	# list NONCE: the contacts whose name holds the nonce, by name, with their starred flag.
	content query --uri $u/contacts --projection display_name:starred --where "display_name LIKE '%$2%'" --sort "display_name ASC" ;;
emails)
	# emails NAME: the contact's email addresses and their types (data2: 1 home, 2 work, 3 other, 4 mobile).
	content query --uri $u/data --projection data1:data2 --where "mimetype='vnd.android.cursor.item/email_v2' AND display_name='$2'" ;;
phones)
	# phones NAME: the contact's phone numbers and their types.
	content query --uri $u/data --projection data1:data2 --where "mimetype='vnd.android.cursor.item/phone_v2' AND display_name='$2'" ;;
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

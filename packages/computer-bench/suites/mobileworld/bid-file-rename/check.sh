# One line: the names in /sdcard/Download that begin with bid_, sorted and joined by spaces, then "|", then
# "ascending" when bid_1 to bid_4 each exist and each is dated later than the one before, or what is wrong.
cd /sdcard/Download || exit 0
names=$(ls -1 | grep '^bid_' | sort | tr '\n' ' ')
order=ascending
prev=0
for n in 1 2 3 4; do
	f=$(ls -1 | grep "^bid_$n\." | head -n 1)
	if [ -z "$f" ]; then order="no bid_$n"; break; fi
	t=$(stat -c %Y "$f")
	if [ "$t" -le "$prev" ]; then order="bid_$n is not later than bid_$((n - 1))"; break; fi
	prev=$t
done
echo "${names% }|$order"

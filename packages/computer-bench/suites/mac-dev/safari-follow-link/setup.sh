# A small local site under /tmp/computer-bench-{{nonce}}: an index of regions, a page per region listing its cities, and a
# page per city. The city pages have names that can't be guessed from the city, so the agent follows the links.
set -e
d="/tmp/computer-bench-{{nonce}}"
rm -rf "$d"
mkdir -p "$d"
page() {
	printf '<!doctype html><html><head><meta charset="utf-8"><title>%s</title></head><body><h1>%s</h1>%s</body></html>\n' "$2" "$2" "$3" > "$d/$1"
}
page index.html "Travel desk" '<p>Pick a region.</p><ul><li><a href="r-eu.html">Europe</a></li><li><a href="r-am.html">Americas</a></li><li><a href="r-as.html">Asia</a></li></ul>'
page r-eu.html "Europe" '<ul><li><a href="p41.html">Lisbon</a></li><li><a href="p17.html">Oslo</a></li></ul><p><a href="index.html">Back</a></p>'
page r-am.html "Americas" '<ul><li><a href="p63.html">Quito</a></li><li><a href="p28.html">Lima</a></li></ul><p><a href="index.html">Back</a></p>'
page r-as.html "Asia" '<ul><li><a href="p55.html">Hanoi</a></li><li><a href="p09.html">Osaka</a></li></ul><p><a href="index.html">Back</a></p>'
page p41.html "Lisbon" '<p>Trams, tiles and custard tarts.</p>'
page p17.html "Oslo" '<p>Fjords and the opera house roof.</p>'
page p63.html "Quito" '<p>A capital high in the Andes.</p>'
page p28.html "Lima" '<p>Ceviche by the Pacific.</p>'
page p55.html "Hanoi" '<p>The Old Quarter and its lakes.</p>'
page p09.html "Osaka" '<p>Street food in Dotonbori.</p>'

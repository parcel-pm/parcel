CLEAN_FILES := dist
PRETTIER_FILES := '**/*.{js,json,less,css,html,xhtml}'
DIST_FILES := \
    manifest.json \
    parcel-host \
    parcel-host.asc \
	css/fonts.css \
    css/popup.css \
    html/popup.html \
    img/logo.svg \
    img/logo-small.svg \
    img/logo-16.png \
    img/logo-32.png \
    img/logo-64.png \
    img/logo-128.png \
    img/icon-copy.svg \
    img/icon-history-nuke.svg \
    img/icon-show-details.svg \
    js/agent.js \
    js/helpers.js \
    js/integration.js \
    js/integration.es6.js \
    js/main-world/shadow.js \
    js/main-world/webauthn.js \
    js/plaintext.js \
    js/popup.js \
    js/schema.js \
    js/selectors.js \
    js/targets.js \
    js/webauthn.js \
	ttf/NotoSansMono-VariableFont_wdth,wght.ttf \
	ttf/Roboto-VariableFont_wdth,wght.ttf \

.PHONY: default
default: prettier dist

.PHONY: prettier
prettier:
	$(PRETTIER) --write $(PRETTIER_FILES)

.PHONY: prettier-check
prettier-check:
	$(PRETTIER) --check $(PRETTIER_FILES)

.PHONY: clean
clean:
	rm -rfv $(CLEAN_FILES)

dist/parcel-host.asc: parcel-host
	echo $(VERSION)
	gpg --yes --sign --detach-sign --include-key-block --armor --default-key 88FF14D6294AF4036B7F00FF676A3C09E2E47A72 --output ./$@ ./$<

dist: $(addprefix dist/,$(DIST_FILES)) dist/parcel-host.asc dist/public_suffix_list.dat;

dist/manifest.json: manifest.json
	install -m 644 -D -t dist manifest.json

dist/parcel-host: parcel-host
	install -m 755 -D -t dist parcel-host

dist/asc/%.asc: asc/%.asc
	install -m 644 -D ./$< ./$@

dist/css/%.css: css/%.css
	install -m 644 -D ./$< ./$@

dist/html/%.html: html/%.html
	install -m 644 -D ./$< ./$@

dist/img/%: img/%
	install -m 644 -D ./$< ./$@

dist/js/%.js: js/%.js
	install -m 644 -D ./$< ./$@


dist/ttf/%.ttf: ttf/%.ttf
	install -m 644 -D ./$< ./$@

dist/public_suffix_list.dat:
	install -m 644 -D -t dist publicsuffix/public_suffix_list.dat

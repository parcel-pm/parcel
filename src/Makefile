CLEAN_FILES := dist
PRETTIER_FILES := '**/*.{js,json,less,css,html,xhtml}'
# Key that signs the main host script. Self-builds override with SIGN_KEY=<fingerprint>; see the
# "Self-build signing" section of README.md before doing so.
SIGN_KEY ?= 88FF14D6294AF4036B7F00FF676A3C09E2E47A72 # gitleaks:allow
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
	@mkdir -p dist
	@if ! command -v gpg >/dev/null 2>&1; then \
		echo "error: gpg is required to sign dist/parcel-host.asc but was not found in PATH" >&2; \
		exit 1; \
	fi
	@if ! gpg --list-secret-keys --quiet $(SIGN_KEY) >/dev/null 2>&1; then \
		echo "error: no GPG secret key for $(SIGN_KEY), cannot sign dist/parcel-host.asc" >&2; \
		echo "" >&2; \
		echo "The host script must be signed at build time: the bootstrap host refuses to" >&2; \
		echo "run it unless it is signed by a key listed in VALID_SIGNERS (see parcelrc)," >&2; \
		echo "so this step cannot be skipped." >&2; \
		echo "" >&2; \
		echo "The default signing key is only available to Parcel release maintainers." >&2; \
		echo "For a self-build, generate your own GPG key, rebuild with" >&2; \
		echo "SIGN_KEY=<your key fingerprint>, and add that fingerprint to VALID_SIGNERS" >&2; \
		echo "in your parcelrc. See the \"Self-build signing\" section of README.md." >&2; \
		exit 1; \
	fi
	gpg --yes --sign --detach-sign --include-key-block --armor --default-key $(SIGN_KEY) --output ./$@ ./$<

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

VERSION ?= $(shell cat .version)
CURRENT_VERSION := $(shell cat .version)

PRETTIER := $(PWD)/node_modules/.bin/prettier
ESLINT := $(PWD)/node_modules/.bin/eslint

.PHONY: all
all: extension chrome firefox

.PHONY: extension
extension:
	$(MAKE) VERSION=$(VERSION) -C ./src

.PHONY: prettier
prettier:
	$(PRETTIER) --write 'test/*.{js,json}'
	$(MAKE) -C ./src PRETTIER=$(PRETTIER) prettier

.PHONY: lint
lint:
	$(ESLINT) .

.PHONY: clean
clean:
	$(MAKE) -C ./src clean
	rm -rvf dist chrome firefox

.PHONY: chrome
chrome: extension
	rsync -av src/dist/ chrome/
	# Inject the webstore public key for unpacked/local installs to ensure a consistent extension ID
	jq ".key=\"MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA6YffJyyl5PdZ/tpQASIn4laZtBltJWnYjzNATud3z/yXQ7deCZnTugm36m+1vsXpNs758OrMs+9tF4Ecl/88QqWyNnLUymsvz7MTVpznTY7X8Wo9yHV7RmU7LU2lC3Zg7SJ5anvVSjXvLIGgjFZTN0bBbwpsADFULni8/sk7eVh1Lx1THjc/pWNEOgEOVVsEUAOqwUwDheoJRBIK0M5lLLqup7TKP9mcMDMUq4CEwLoWge98L6D0rQMJy48VYLEXlUWTVcjeyc2DJYBaGvMVWXc81+eajQrV/NZ5hu66ofuLifDUbjr3S0v6kxlqBoAhdjMOa1twoO1Y0KXxvdDhzwIDAQAB\"" src/dist/manifest.json > chrome/manifest.json

.PHONY: firefox
firefox: extension
	rsync -av src/dist/ firefox/
	jq "\
		.background.scripts=[.background.service_worker] \
		|del(.background.service_worker) \
		|.permissions += [\"contextualIdentities\"] \
		|.browser_specific_settings.gecko.id=\"parcel@erayd.net\" \
		|.browser_specific_settings.gecko.data_collection_permissions.required=[\"none\"] \
		|.content_scripts |= map(\
		    if .type == \"module\" \
		        then del(.type) | .js|=map(gsub(\".js\"; \".es6.js\")) \
			else . \
		    end \
	        ) \
	        " src/dist/manifest.json > firefox/manifest.json

.PHONY: release
release: clean extension
ifeq ($(VERSION), $(CURRENT_VERSION))
else
	echo $(VERSION) > .version
	jq ".version = \"$(VERSION)\"" src/manifest.json | $(PRETTIER) --parser json | sponge src/manifest.json
	$(PRETTIER) --write src/manifest.json
	git reset
	git add .version src/manifest.json
	git commit -m "Release v$(VERSION)"
	git tag v$(VERSION)
endif
	$(MAKE) chrome firefox
	[ -d dist ] || mkdir -p dist
	git archive -o dist/parcel-$(VERSION).tar --format tar --prefix=parcel-$(VERSION)/ v$(VERSION)
	gzip -9 dist/parcel-$(VERSION).tar
	(cd chrome && zip -r ../dist/parcel-chrome-$(VERSION).zip *)
	(cd firefox && zip -r ../dist/parcel-firefox-$(VERSION).zip *)
	install -m 755 -D -t dist parcel-host
	for file in dist/*; do gpg --detach-sign --armor "$$file"; done

.PHONY: test-native
test-native:
	node --test $(TEST_FLAGS) test/native-host.test.js

.PHONY: test-browser-mock
test-browser-mock:
	node --test $(TEST_FLAGS) test/chrome-api-mock.test.js

.PHONY: test-modules
test-modules:
	node --test $(TEST_FLAGS) test/helpers.test.js test/plaintext.test.js test/schema.test.js test/selectors.test.js test/targets.test.js test/shadow.test.js

.PHONY: test-application
test-application:
	node --test $(TEST_FLAGS) test/agent.test.js test/integration.test.js test/popup.test.js test/popup-context.test.js

.PHONY: test-syntax
test-syntax:
	$(PRETTIER) --check 'test/*.{js,json}'
	$(MAKE) -C ./src PRETTIER=$(PRETTIER) prettier-check
	$(ESLINT) .

.PHONY: test
test: test-syntax
	node --test $(TEST_FLAGS) \
		test/chrome-api-mock.test.js \
		test/helpers.test.js \
		test/native-host.test.js \
		test/plaintext.test.js \
		test/schema.test.js \
		test/selectors.test.js \
		test/targets.test.js \
		test/shadow.test.js \
		test/agent.test.js \
		test/integration.test.js \
		test/popup.test.js \
		test/popup-context.test.js

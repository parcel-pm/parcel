VERSION ?= $(shell cat .version)
CURRENT_VERSION := $(shell cat .version)
WEBPACK_MODE := development

.PHONY: all
all: extension chrome firefox

.PHONY: extension
extension:
	$(MAKE) VERSION=$(VERSION) -C ./src

.PHONY: clean
clean:
	$(MAKE) -C ./src clean
	rm -rvf dist chrome firefox

.PHONY: chrome
chrome: extension
	rsync -av src/dist/ chrome/
	#[ $(WEBPACK_MODE) = "production" ] || jq ".key=\"MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAted7WSl3dHs767uh16stdYaXCOXv3XGcWokWsDd56svrU6zhTrEzBkZGozMdqOygDBfZQ6eaRKlR4vHu/7tny1Z3f/rRO7c9dSk6pQjF/gNmsfNd4XyrtujRmPiPwi3Gcyn1Sizpkhn+Bfp3gvim/jLkqpZu9rOgSMxZOaqLOs2SSdaOr9dWhqV5eo6el5D/diL6HDzzMbgUr8NxePQ1PnZnoX1Qjms/jIfxpeEYZeaEjFNCQJKffK/zZWs8CD+mTEbJALYxwuMNueKsie2J07buyW1ZTtczeei45MDQc6yY0C7lcqhk+/7nqnJZfdkc0g1fNvTPXwzGxhFr+bpfZwIDAQAB\"" src/dist/manifest.json > chrome/manifest.json

.PHONY: firefox
firefox: extension
	rsync -av src/dist/ firefox/
	jq "\
		.background.scripts=[.background.service_worker] \
		|del(.background.service_worker) \
		|.permissions += [\"contextualIdentities\"] \
		|.browser_specific_settings.gecko.id=\"parcel@mozilla.org\" \
		|.content_scripts |= map(\
		    if .type == \"module\" \
		        then del(.type) | .js|=map(gsub(\".js\"; \".es6.js\")) \
			else . \
		    end \
	        ) \
	        " src/dist/manifest.json > firefox/manifest.json

.PHONY: release
release: WEBPACK_MODE=production
release: clean extension
ifeq ($(VERSION), $(CURRENT_VERSION))
else
	echo $(VERSION) > .version
	jq ".version = \"$(VERSION)\"" src/manifest.json | prettier --parser json | sponge src/manifest.json
	git reset
	git add .version src/manifest.json src/asc/*.asc
	git commit -m "Release v$(VERSION)"
	git tag v$(VERSION)
endif
	$(MAKE) WEBPACK_MODE=$(WEBPACK_MODE) chrome firefox
	[ -d dist ] || mkdir -p dist
	git archive -o dist/parcel-$(VERSION).tar --format tar --prefix=parcel-$(VERSION)/ v$(VERSION)
	find src/sites | xargs tar -uhf dist/parcel-$(VERSION).tar --transform "s,^,parcel-$(VERSION)/,"
	gzip -9 dist/parcel-$(VERSION).tar
	(cd chrome && zip -r ../dist/parcel-chrome-$(VERSION).zip *)
	(cd firefox && zip -r ../dist/parcel-firefox-$(VERSION).zip *)
	for file in dist/*; do gpg --detach-sign --armor "$$file"; done

.PHONY: test-native
test-native:
	node test/native-host.test.js

.PHONY: test-browser-mock
test-browser-mock:
	node --test test/chrome-api-mock.test.js

.PHONY: test-modules
test-modules:
	node --test test/helpers.test.js test/plaintext.test.js

.PHONY: test
test:
	node --test \
		test/chrome-api-mock.test.js \
		test/helpers.test.js \
		test/native-host.test.js \
		test/plaintext.test.js

.PHONY: build clean deploy

init:
	docker run --rm -it \
	-v "$(CURDIR)":/home/neqo \
	my_neqo \
	bash -c '\
	set -eux; \
        hg clone -u NSS_3_73_RTM https://hg.mozilla.org/projects/nss "$NSS_DIR"; \
	hg clone -u NSPR_4_32_RTM https://hg.mozilla.org/projects/nspr "$NSPR_DIR"; \
	mkdir -p nss_db;'

cert:
	docker run --rm -it \
	-v "$(CURDIR)":/home/neqo \
	my_neqo \
	bash -c '\
	set -eux; \
	mkdir -p nss_db; \
	./dist/Debug/bin/certutil -N -d nss_db; \
	openssl pkcs12 -export -in certificate.pem -inkey certificate.key -out certificate.pfx; \
	./dist/Debug/bin/pk12util -i certificate.pfx -n "Test Certificate" -d nss_db; \
	./dist/Debug/bin/certutil -L -d nss_db;'

build:
	docker run --rm -it \
	-v "$(CURDIR)":/home/neqo \
	-v ~/.cargo/git:/usr/local/cargo/git \
 	-v ~/.cargo/registry:/usr/local/cargo/registry \
	my_neqo \
	-p 4433:4433/udp \
	RUSTFLAGS="$RUSTFLAGS -A dead_code" cargo build

fmt:
	docker run --rm -it \
	-v "$(CURDIR)":/home/neqo \
	my_neqo \
	bash -c "cargo fmt"

sh:
	docker run --rm -it \
	-v "$(CURDIR)":/home/neqo \
	-v ~/.cargo/git:/usr/local/cargo/git \
 	-v ~/.cargo/registry:/usr/local/cargo/registry \
	-p 4433:4433/udp \
	my_neqo 

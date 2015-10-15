CFLAGS=-Wall -std=c99 -pedantic -O2 -static

SRC=src/init.c
DIR=build
TARGET=$(DIR)/sourcebox-init

.PHONY: clean

$(TARGET): $(SRC)
	mkdir -p $(DIR)
	$(CC) $(CFLAGS) $< -o $@

clean:
	rm -rf $(DIR)

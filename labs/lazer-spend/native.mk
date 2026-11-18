# Included after the pinned LaZer Makefile in a disposable build directory.
.PHONY: mobubu-lazer
mobubu-lazer:
	$(CC) -std=gnu2x -include stdalign.h -O3 -march=native -fwrapv -ffast-math -DNDEBUG \
	  -DLOGQ=38 -fPIC -fvisibility=hidden -shared -Wl,-z,defs \
	  -I$(LABRADOR_DIR) -I"$(WORK_DIR)" -o "$(WORK_DIR)/libmobubu_lazer.so" \
	  $(LABRADOR_SRC) "$(LAB_DIR)/spend.c" "$(LAB_DIR)/wire.c" $(LABRADOR_LIBS)

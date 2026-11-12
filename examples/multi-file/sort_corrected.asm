
# ==========================================
# MEMORY MACROS
# ==========================================

# mem[A]++
macro incmem/1
    ldi r0, $1
    ld r0, r1
    inc r1
    st r0, r1
mend

# mem[A]--
macro decmem/1
    ldi r0, $1
    ld r0, r1
    dec r1
    st r0, r1
mend

# mem[A] = VALUE (immediate)
macro setmem/2
    ldi r0, $1
    ldi r1, $2
    st r0, r1
mend

# mem[B] = mem[A]
macro copymem/2
    ldi r0, $1
    ld r0, r1
    ldi r2, $2
    st r2, r1
mend

# Swap mem[A] and mem[B]
macro swapmem/2
    ldi r0, $1
    ldi r2, $2

    ld r0, r1
    ld r2, r3

    st r0, r3
    st r2, r1
mend

# mem[B] += mem[A]
macro summem/2
    ldi r0, $1
    ld r0, r1

    ldi r2, $2
    ld r2, r3

    add r1, r3
    st r2, r3
mend

# mem[B] -= mem[A]
macro submem/2
    ldi r0, $1
    ld r0, r1

    ldi r2, $2
    ld r2, r3

    sub r1, r3
    st r2, r3
mend

# mem[B] *= mem[A]
# Unsigned multiplication modulo 256
macro mulmem/2
    ldi r0, $1
    ld r0, r1

    ldi r0, $2
    ld r0, r2

    clr r3
    while
        tst r2
    stays nz
        add r1, r3
        dec r2
    wend

    st r0, r3
mend


# ==========================================
# STACK MACROS
# ==========================================

# mem[SP + OFFSET]++
macro incstack/1
    ldsa r0, $1
    ld r0, r1
    inc r1
    st r0, r1
mend

# mem[SP + OFFSET]--
macro decstack/1
    ldsa r0, $1
    ld r0, r1
    dec r1
    st r0, r1
mend

# REG = mem[SP + OFFSET]
# REG must be r0, r1, r2 or r3
macro getstack/2
    ldsa $1, $2
    ld $1, $1
mend

# mem[SP + DST] = mem[SP + SRC]
macro setstack/2
    ldsa r0, $2
    ld r0, r1

    ldsa r2, $1
    st r2, r1
mend

# mem[SP + OFFSET] = VALUE (immediate)
macro setstacki/2
    ldsa r0, $1
    ldi r1, $2
    st r0, r1
mend

# mem[SP + DST] += mem[SP + SRC]
macro sumstack/2
    ldsa r0, $1
    ld r0, r1

    ldsa r2, $2
    ld r2, r3

    add r1, r3
    st r2, r3
mend

# mem[SP + DST] -= mem[SP + SRC]
macro substack/2
    ldsa r0, $1
    ld r0, r1

    ldsa r2, $2
    ld r2, r3

    sub r3, r1
    st r2, r3
mend

# Swap two stack cells
macro swapstack/2
    ldsa r0, $1
    ldsa r2, $2

    ld r0, r1
    ld r2, r3

    st r0, r3
    st r2, r1
mend

# mem[SP + DST] *= mem[SP + SRC]
# Unsigned multiplication modulo 256
macro mulstack/2
    ldsa r0, $1
    ld r0, r1

    ldsa r2, $2
    ld r2, r3

    clr r0
    while
        tst r3
    stays nz
        add r1, r0
        dec r3
    wend

    ldsa r2, $2
    st r2, r0
mend

# ==========================================
# POINTER MACROS
# ==========================================

# mem[PTR]++
# PTR must not be r3
macro incptr/1
    ld $1, r3
    inc r3
    st $1, r3
mend

# mem[PTR]--
# PTR must not be r3
macro decptr/1
    ld $1, r3
    dec r3
    st $1, r3
mend

# Swap mem[r0] and mem[r2]
macro swapptr/0
    ld r0, r1
    ld r2, r3

    st r0, r3
    st r2, r1
mend
run main

# Frame after addsp -3:
# SP + 0: j
# SP + 1: i
# SP + 2: pivot value
# SP + 3: return address
# SP + 4: array base address
# SP + 5: array length
#
# QuickSort(A, N), in-place unsigned byte sorting.
# Clobbers r0-r3. The routine has no return-value slot.
sort_v3:
addsp -3

getstack r1, 5  # N
ldi r2, 1
if
    cmp r1, r2
is hi  # Only partition if N > 1
then
    # pivot = mem[A + N - 1]
    getstack r0, 4  # A
    getstack r1, 5  # N
    dec r1
    add r1, r0      # r0 = A + N - 1
    ld r0, r1       # r1 = pivot value
    ldsa r0, 2
    st r0, r1       # local pivot = r1

    setstacki 1, 0  # i = 0
    setstacki 0, 0  # j = 0

    while
        getstack r0, 0  # j
        getstack r1, 5  # N
        dec r1          # last index = N - 1
        cmp r0, r1
    stays lo  # j < N - 1
        getstack r0, 4  # A
        getstack r1, 0  # j
        add r1, r0      # r0 = A + j
        ld r0, r2       # r2 = A[j]
        getstack r1, 2  # pivot
        if
            cmp r2, r1
        is lo  # A[j] < pivot
            getstack r0, 4  # A
            getstack r1, 1  # i
            add r1, r0      # r0 = A + i

            getstack r2, 4  # A
            getstack r1, 0  # j
            add r1, r2      # r2 = A + j
            swapptr         # swap mem[r0], mem[r2]
            incstack 1      # i++
        fi
        incstack 0  # j++
    wend

    # Final pivot placement: swap(A[i], A[N-1])
    getstack r0, 4  # A
    getstack r1, 1  # i
    add r1, r0      # r0 = A + i
    getstack r2, 4  # A
    getstack r1, 5  # N
    dec r1
    add r1, r2      # r2 = A + N - 1
    swapptr

    # QuickSort(A, i)
    getstack r1, 1  # left length = i
    getstack r0, 4  # left address = A
    push r1         # length, pushed first
    push r0         # address, pushed second
    jsr sort_v3
    addsp 2         # discard exactly two arguments

    # QuickSort(A + i + 1, N - i - 1)
    getstack r0, 4  # A
    getstack r1, 1  # i
    add r1, r0
    inc r0          # right address

    # Правая часть: N - i - 1

    getstack r2, 1  # r2 = i
    getstack r1, 5  # r1 = N
    sub r1, r2      # r2 = N - i
    dec r2          # r2 = N - i - 1

    push r2
    push r0
    jsr sort_v3
    addsp 2
fi

addsp 3  # discard j, i, pivot before rts
rts

main:
ldi r0, arr
ldi r1, 6
push r1  # length
push r0  # array address
jsr sort_v3
addsp 2  # no return slot: remove 2 args
halt

arr:
dc 9, 2, 0, 1, 4, 10
end

"""Extract LaZer's published degree-512 Merkle hash matrix as a C initializer."""
import ast
from pathlib import Path
import sys


def main():
    source = ast.parse(Path(sys.argv[1]).read_text())
    matrix, = (
        ast.literal_eval(node.value)
        for node in source.body if isinstance(node, ast.Assign)
        if any(isinstance(t, ast.Name) and t.id == "list_urandom_matrix_hash" for t in node.targets)
    )
    if len(matrix) != 16 * 512 or any(type(x) is not int or not -128 <= x < 128 for x in matrix):
        raise ValueError("unexpected LaZer hash matrix")
    print("/* Generated from the pinned LaZer archive (MIT); see README. */")
    print("static const int16_t ajtai[16][512] = {")
    for row in range(16):
        print("  {" + ",".join(map(str, matrix[row * 512:(row + 1) * 512])) + "},")
    print("};")


if __name__ == "__main__":
    main()

import onnx

MODEL_PATH = "models/gui-detector/model.onnx"

model = onnx.load(MODEL_PATH)

print("=" * 60)
print("MODEL INFORMATION")
print("=" * 60)

print("IR version:", model.ir_version)

print("Opset:")
for opset in model.opset_import:
    print(" ", opset.domain or "ai.onnx", opset.version)

print("\nINPUTS")
for tensor in model.graph.input:
    shape = []

    for dim in tensor.type.tensor_type.shape.dim:
        if dim.dim_value:
            shape.append(dim.dim_value)
        elif dim.dim_param:
            shape.append(dim.dim_param)
        else:
            shape.append("?")

    print("Name :", tensor.name)
    print("Shape:", shape)

print("\nOUTPUTS")
for tensor in model.graph.output:
    shape = []

    for dim in tensor.type.tensor_type.shape.dim:
        if dim.dim_value:
            shape.append(dim.dim_value)
        elif dim.dim_param:
            shape.append(dim.dim_param)
        else:
            shape.append("?")

    print("Name :", tensor.name)
    print("Shape:", shape)

print("\n" + "=" * 60)
print("DONE")
print("=" * 60)
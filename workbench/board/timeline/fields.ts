import type { TypeSpecView } from "../views/format.ts";
import type { Dimension } from "./scale.ts";

export function timelineFields(spec?: TypeSpecView): Dimension[] {
  return Object.entries(spec?.schema?.properties ?? {}).flatMap(
    ([field, schema]) => {
      const widget = schema["x-sand-widget"];
      if (
        schema["x-sand-hidden"] === true ||
        (widget !== "date" && widget !== "number" && widget !== "integer")
      )
        return [];
      return [
        {
          kind: widget === "date" ? "date" : "number",
          field,
          label: schema["x-sand-label"] ?? field,
        },
      ];
    },
  );
}

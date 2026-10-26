import { KEYS } from "@excalidraw/common";

import { Excalidraw } from "../..";
import { Keyboard } from "../../tests/helpers/ui";
import { act, render } from "../../tests/test-utils";

describe("FontPicker", () => {
  it("should be able to open font picker", async () => {
    (global as any).ResizeObserver =
      (global as any).ResizeObserver ||
      class ResizeObserver {
        observe() {}
        unobserve() {}
        disconnect() {}
      };

    const { queryByTestId } = await render(
      <Excalidraw handleKeyboardGlobally={true} />,
    );

    Keyboard.keyPress(KEYS.T);

    const fontPickerTrigger = queryByTestId("font-family-show-fonts");

    expect(fontPickerTrigger).not.toBeNull();

    act(() => {
      fontPickerTrigger!.click();
    });
  });

  it("should list Proxima Nova Extra Condensed", async () => {
    (global as any).ResizeObserver =
      (global as any).ResizeObserver ||
      class ResizeObserver {
        observe() {}
        unobserve() {}
        disconnect() {}
      };

    const { queryByTestId, queryByText } = await render(
      <Excalidraw handleKeyboardGlobally={true} />,
    );

    Keyboard.keyPress(KEYS.T);

    act(() => {
      queryByTestId("font-family-show-fonts")!.click();
    });

    expect(queryByText("Proxima Nova Extra Condensed")).not.toBeNull();
  });

  it("should list Proxima Nova Extra Condensed Bold", async () => {
    (global as any).ResizeObserver =
      (global as any).ResizeObserver ||
      class ResizeObserver {
        observe() {}
        unobserve() {}
        disconnect() {}
      };

    const { queryByTestId, queryByText } = await render(
      <Excalidraw handleKeyboardGlobally={true} />,
    );

    Keyboard.keyPress(KEYS.T);

    act(() => {
      queryByTestId("font-family-show-fonts")!.click();
    });

    expect(queryByText("Proxima Nova Extra Condensed Bold")).not.toBeNull();
  });
});

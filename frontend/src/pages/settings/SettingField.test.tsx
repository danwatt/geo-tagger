import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SettingField, type Setting } from "./SettingField";

const intSetting: Setting = {
  key: "WORKQUEUE_MIN_SIZE", type: "int", group: "Work queue", label: "Minimum batch size",
  help: "Batches smaller than this never reach the queue.", min: 1, max: 500, step: 1,
  value: 5, default: 5, overridden: false,
};
const boolSetting: Setting = {
  key: "RAW_FULL_DECODE", type: "bool", group: "RAW photos", label: "Full RAW decode",
  help: "Fully demosaic RAW files.", value: false, default: false, overridden: false,
};

function setup(setting: Setting, onSave = vi.fn(async (_k: string, v: number) => v), onReset = vi.fn(async () => {})) {
  const user = userEvent.setup();
  render(<SettingField setting={setting} onSave={onSave} onReset={onReset} />);
  return { user, onSave, onReset };
}

describe("SettingField", () => {
  it("shows the label, help and default", () => {
    setup(intSetting);
    expect(screen.getByLabelText("Minimum batch size")).toHaveValue(5);
    expect(screen.getByText(/never reach the queue\. \(default: 5\)/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reset to default" })).not.toBeInTheDocument();
  });

  it("saves a number on Enter, not on each keystroke", async () => {
    const { user, onSave } = setup(intSetting);
    const input = screen.getByLabelText("Minimum batch size");
    await user.clear(input);
    await user.type(input, "12");
    expect(onSave).not.toHaveBeenCalled();
    await user.keyboard("{Enter}");
    expect(onSave).toHaveBeenCalledWith("WORKQUEUE_MIN_SIZE", 12);
    expect(await screen.findByText("Saved")).toBeInTheDocument();
  });

  it("doesn't save an unchanged value on blur", async () => {
    const { user, onSave } = setup(intSetting);
    await user.click(screen.getByLabelText("Minimum batch size"));
    await user.tab();
    expect(onSave).not.toHaveBeenCalled();
  });

  it("saves a checkbox toggle as 1/0", async () => {
    const { user, onSave } = setup(boolSetting);
    await user.click(screen.getByLabelText("Full RAW decode"));
    expect(onSave).toHaveBeenCalledWith("RAW_FULL_DECODE", 1);
  });

  it("shows the server's error on the row", async () => {
    const onSave = vi.fn(async () => {
      throw new Error("WORKQUEUE_MIN_SIZE must be between 1 and 500");
    });
    const { user } = setup(intSetting, onSave);
    const input = screen.getByLabelText("Minimum batch size");
    await user.clear(input);
    await user.type(input, "9999{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent("must be between 1 and 500");
    // Leaving the field doesn't resend the value the server just rejected.
    await user.tab();
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it("offers Reset only when overridden", async () => {
    const { user, onReset } = setup({ ...intSetting, value: 9, overridden: true });
    await user.click(screen.getByRole("button", { name: "Reset to default" }));
    await waitFor(() => expect(onReset).toHaveBeenCalledWith("WORKQUEUE_MIN_SIZE"));
  });
});

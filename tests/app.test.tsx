import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import App from "../src/ui/App";

/** 界面冒烟：只验证关键文案与交互路径，业务规则仍由 engine.test.ts 覆盖。 */
describe("界面", () => {
  it("打开计划页即展示未完成结论与逐副本结果", () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /删除计划与回执/ }));
    expect(screen.getAllByText(/不得显示完成：仍有/).length).toBeGreaterThan(0);
    const targets = screen.getAllByLabelText("逐副本结果")[0];
    expect(targets).toBeTruthy();
    expect(within(targets).getByText("热备副本 · 上海")).toBeTruthy();
    expect(within(targets).getByText("失败")).toBeTruthy();
  });

  it("导入数据集后出现在待处理队列", () => {
    render(<App />);
    fireEvent.change(screen.getByLabelText("数据集名称"), { target: { value: "月度对账快照" } });
    fireEvent.change(screen.getByLabelText("版本标识"), { target: { value: "2026.11" } });
    fireEvent.change(screen.getByLabelText("保留期限（天）"), { target: { value: "1" } });
    fireEvent.click(screen.getByRole("button", { name: "导入数据集" }));
    expect(screen.getAllByText("月度对账快照").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/已导入「月度对账快照 2026.11」/).length).toBeGreaterThan(0);
  });

  it("空名称导入给出校验错误且不落库", () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "导入数据集" }));
    expect(screen.getByRole("alert").textContent).toContain("请填写数据集名称");
  });

  it("时间线列出法律保留的留痕", () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /时间线/ }));
    fireEvent.change(screen.getByLabelText("按数据版本筛选时间线"), {
      target: { value: "ver-1004" },
    });
    expect(screen.getAllByText(/进入法律保留，不参与执行/).length).toBeGreaterThan(0);
  });
});

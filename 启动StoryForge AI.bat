@echo off
chcp 65001 >nul
title AI短剧工坊

:: 检查node_modules是否存在
if not exist "node_modules\electron" (
    echo 正在首次安装，请稍候...
    echo.
    npm install --save-dev electron
    echo.
    echo 安装完成！
    echo.
)

:: 启动应用
echo 正在启动 AI短剧工坊...
npx electron .

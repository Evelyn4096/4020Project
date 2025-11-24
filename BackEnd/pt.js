const express=require('express');
const app=express();
app.listen(3000,() => {console.log("EXpress run on http://localhost:3000")});
app.set("view engine","ejs");
app.set('views','FrontEnd_react');
app.get('/',(req,res) => {
    res.render("index", {title: 'home'})
})
